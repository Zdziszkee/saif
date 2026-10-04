/**
 * Gateway turn orchestration for `POST /v1/chat/completions`.
 *
 * Stage order per the lifecycle contract: resolve identity, enforce the
 * caller's usage limit (before any control tier runs, so an over-limit
 * caller never consumes decision-model calls), validate the new user content
 * through the shared control pipeline, then forward upstream and settle
 * usage/cost when the stream ends. Only inbound user text is ever inspected;
 * answers stream back verbatim and are never stored.
 *
 * Storage writes go only through {@link GatewayStore}. Pricing arrives
 * through the {@link PriceForModel} seam (owned by `src/gateway/pricing.ts`):
 * `costUsd` is the blended USD cost of a single token for the model, and the
 * lifecycle multiplies it by observed token counts. An unpriced model settles
 * with an unknown (`null`) cost rather than a silent zero.
 */

import { guardInteraction } from "#/control/guard.ts";
import type { Policy } from "#/control/policy/schema.ts";
import { applyRedactions } from "#/control/redact.ts";
import { SemanticConfigurationError } from "#/control/semantic/errors.ts";
import { checksForGroup, type SemanticConfig } from "#/control/semantic/index.ts";
import {
	type CallerIdentity,
	type IdentityResolver,
	identityFromRequest,
} from "#/control/subjects.ts";
import type {
	ControlHit,
	ControlPipeline,
	InspectionResult,
	RedactionSpan,
	Verdict,
} from "#/control/types.ts";
import { isBlockingVerdict } from "#/control/types.ts";
import type { AuditCause } from "#/db/schema.ts";
import type { PriceLookup } from "#/gateway/pricing.ts";
import type { GatewayAuditRow, GatewayStore, SpendSummary } from "#/gateway/store.ts";
import { createIdSequence } from "#/lib/ids.ts";
import type { DecisionLogHit, DecisionLogInput } from "./decision-log.ts";
import { formatDecisionLine } from "./decision-log.ts";
import { type GatewayChatBody, parseGatewayBody, type UserSlice, userSlices } from "./request.ts";
import {
	type FetchImpl,
	streamUpstreamCompletion,
	UpstreamError,
	type UpstreamUsage,
} from "./upstream.ts";

export const HTTP_OK = 200;
export const HTTP_BAD_REQUEST = 400;
export const HTTP_UNAUTHORIZED = 401;
export const HTTP_FORBIDDEN = 403;
export const HTTP_TOO_MANY_REQUESTS = 429;
export const HTTP_BAD_GATEWAY = 502;
export const HTTP_INTERNAL_ERROR = 500;
export const HTTP_SERVICE_UNAVAILABLE = 503;

/** Token reservation: characters-per-token heuristic plus fixed overhead. */
const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4;
const TOKEN_ESTIMATE_OVERHEAD = 8;

const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86_400;
const DAYS_PER_MONTH = 30;
const MS_PER_SECOND = 1000;
const ALL_MODELS_SCOPE = "*";
const PIPELINE_CONTROL = "pipeline";
const STREAM_CONTENT_TYPE = "text/event-stream";
const DECISION_DIRECTION = "inbound";
const BUDGET_EXHAUSTED_OUTCOME = "budget-exhausted";
const UPSTREAM_OK = "ok";
const UPSTREAM_FAILURE_OUTCOME = "upstream-failure";
const CALLER_IDENTITY_CONTROL = "caller-identity";
const REQUEST_SHAPE_CONTROL = "request-shape";
const SEMANTIC_CHECKS_CONTROL = "semantic-checks";
const BUDGET_CONTROL = "budget";

/** Wire keys written to the upstream body (string access, never identifiers). */
const STREAM_OPTIONS_KEY = "stream_options";
const INCLUDE_USAGE_KEY = "include_usage";

const nextGatewayInteractionId = createIdSequence("gateway");

/**
 * Cost lookup for a model, or `null` when the price table has no entry.
 * Unknown models never fabricate a zero — the caller records them unpriced.
 */
export type PriceForModel = (model: string) => PriceLookup | null;

export interface GatewayPolicySnapshot {
	budget: Policy["controls"]["budget"];
	policyVersion: string;
}

export interface GatewayUpstreamConfig {
	apiKey: string | undefined;
	baseUrl: string;
	defaultModel: string | undefined;
}

export interface GatewayTurnDeps {
	clock?: (() => number) | undefined;
	fetchImpl?: FetchImpl | undefined;
	identity: IdentityResolver;
	pipeline: ControlPipeline;
	policy: GatewayPolicySnapshot;
	priceFor: PriceForModel;
	request: Request;
	semanticConfig: SemanticConfig;
	store: GatewayStore;
	upstream: GatewayUpstreamConfig;
}

/** Validated turn context shared by every stage after request parsing. */
interface TurnState {
	body: GatewayChatBody;
	caller: CallerIdentity;
	deps: GatewayTurnDeps;
	model: string;
	/** Newest-turn slices from `userSlices()` (newest user message only). */
	slices: UserSlice[];
}

/** Newest-turn slice; history never participates in validation. */
function newestSlice(slices: readonly UserSlice[]): UserSlice | null {
	return slices.at(-1) ?? null;
}

/** Verbatim text of the newest user turn only. */
function newestText(slices: readonly UserSlice[]): string {
	return newestSlice(slices)?.text ?? "";
}

/** Length of the newest turn for budget reservation. */
function newestLength(slices: readonly UserSlice[]): number {
	return newestText(slices).length;
}

/** Decisive check evidence for one audit row. */
interface TurnEvidence {
	controlId: string;
	decisive: ControlHit | null;
	detail: string | null;
	score: number | null;
}

const EVIDENCE_DETAIL_SEPARATOR = "; ";

/** Hits that share the terminal verdict, in pipeline order. */
function matchingHits(hits: readonly ControlHit[], verdict: string): ControlHit[] {
	return hits.filter((hit) => hit.verdict === verdict);
}

/** First verdict-matching hit; falls back to the first hit to preserve allow/flag mapping. */
function primaryHit(hits: readonly ControlHit[], verdict: string): ControlHit | null {
	const matching = matchingHits(hits, verdict);
	if (matching.length > 0) {
		return matching.at(0) ?? null;
	}
	return hits.at(0) ?? null;
}

/** Evidence sources: verdict-matching hits, or the first hit when none match. */
function evidenceSources(hits: readonly ControlHit[], verdict: string): readonly ControlHit[] {
	const matching = matchingHits(hits, verdict);
	return matching.length > 0 ? matching : hits.slice(0, 1);
}

function checkIdForHit(hit: ControlHit | null, fallback: string): string {
	if (hit === null) {
		return fallback;
	}
	return hit.kind.trim().length > 0 ? hit.kind : fallback;
}

function combinedDetail(sources: readonly ControlHit[]): string | null {
	const parts: string[] = [];
	for (const hit of sources) {
		if (typeof hit.detail === "string" && hit.detail.trim().length > 0) {
			parts.push(hit.detail);
		}
	}
	return parts.length > 0 ? parts.join(EVIDENCE_DETAIL_SEPARATOR) : null;
}

function firstFiniteScore(sources: readonly ControlHit[]): number | null {
	for (const hit of sources) {
		if (typeof hit.score === "number" && Number.isFinite(hit.score)) {
			return hit.score;
		}
	}
	return null;
}

function failureDetail(failure: string | undefined): string | null {
	if (failure === undefined) {
		return null;
	}
	return failure.trim().length > 0 ? failure : null;
}

function evidenceForVerdict(
	hits: readonly ControlHit[],
	verdict: string,
	fallbackControl: string,
): TurnEvidence {
	const primary = primaryHit(hits, verdict);
	const sources = evidenceSources(hits, verdict);
	return {
		controlId: checkIdForHit(primary, fallbackControl),
		decisive: primary,
		detail: combinedDetail(sources),
		score: firstFiniteScore(sources),
	};
}

function evidenceForBlocked(
	inspection: InspectionResult,
	verdict: string,
	fallbackControl: string,
): TurnEvidence {
	const primary = primaryHit(inspection.hits, verdict);
	if (inspection.failure !== undefined) {
		return {
			controlId: checkIdForHit(primary, fallbackControl),
			decisive: primary,
			detail: failureDetail(inspection.failure),
			score: null,
		};
	}
	const sources = evidenceSources(inspection.hits, verdict);
	return {
		controlId: checkIdForHit(primary, fallbackControl),
		decisive: primary,
		detail: combinedDetail(sources),
		score: firstFiniteScore(sources),
	};
}

function toDecisionHits(hits: readonly ControlHit[]): DecisionLogHit[] {
	return hits.map((hit) => ({
		controlId: hit.controlId,
		detail: hit.detail,
		kind: hit.kind,
		score: hit.score,
		verdict: hit.verdict,
	}));
}

function decisionTimestamp(deps: GatewayTurnDeps): string {
	try {
		const seconds = deps.clock === undefined ? Date.now() / MS_PER_SECOND : deps.clock();
		if (!Number.isFinite(seconds)) {
			return new Date().toISOString();
		}
		return new Date(seconds * MS_PER_SECOND).toISOString();
	} catch {
		return new Date().toISOString();
	}
}

function writeDecisionLine(input: DecisionLogInput): void {
	// biome-ignore lint/correctness/noProcessGlobal: gateway observability writes one decision line to stdout
	process.stdout.write(`${formatDecisionLine(input)}\n`);
}

/** OpenAI error envelope: `{ error: { message, type, code } }`. */
export function openAiError(
	status: number,
	message: string,
	errorType: string,
	code: string,
): Response {
	return Response.json({ error: { code, message, type: errorType } }, { status });
}

type TurnStep = { caller: CallerIdentity } | { response: Response };

/**
 * One governed turn: identity, budget precheck, validation, upstream SSE
 * with end-of-stream settlement.
 */
export async function runGatewayTurn(deps: GatewayTurnDeps): Promise<Response> {
	const resolved = await resolveCaller(deps);
	if ("response" in resolved) {
		return resolved.response;
	}
	return runGovernedTurn(deps, resolved.caller);
}

async function resolveCaller(deps: GatewayTurnDeps): Promise<TurnStep> {
	const presented = identityFromRequest(deps.request);
	const resolution = deps.identity.resolve(presented.userId, presented.groupId);
	if (resolution.ok) {
		return { caller: resolution.identity };
	}
	const missing = resolution.kind === "missing-identity";
	const userId = resolution.userId ?? "";
	const groupId = resolution.groupId ?? "";
	await recordTurnAudit(deps, {
		cause: missing ? "missing-identity" : "unknown-group",
		controlId: CALLER_IDENTITY_CONTROL,
		detail: null,
		groupId,
		model: null,
		promptText: null,
		score: null,
		userId,
		verdict: "block",
	});
	writeDecisionLine({
		blockingControl: CALLER_IDENTITY_CONTROL,
		direction: DECISION_DIRECTION,
		groupId,
		hits: [],
		outcome: "block",
		timestamp: decisionTimestamp(deps),
		upstream: { outcome: "unknown" },
		userId,
	});
	return {
		response: openAiError(
			missing ? HTTP_UNAUTHORIZED : HTTP_FORBIDDEN,
			resolution.reason,
			missing ? "authentication_error" : "permission_error",
			missing ? "missing-identity" : "unknown-group",
		),
	};
}

async function runGovernedTurn(deps: GatewayTurnDeps, caller: CallerIdentity): Promise<Response> {
	const parsed = await readRequestBody(deps.request);
	const validation = parseGatewayBody(parsed);
	if (!validation.ok) {
		return rejectMalformed(deps, caller, validation.errors);
	}
	const model = validation.body.model ?? deps.upstream.defaultModel;
	if (model === undefined) {
		return rejectMissingModel(deps, caller);
	}
	const state: TurnState = {
		body: validation.body,
		caller,
		deps,
		model,
		slices: userSlices(validation.body),
	};
	const semanticRejection = await rejectUnknownSemanticGroup(deps, caller);
	if (semanticRejection !== null) {
		return semanticRejection;
	}
	const budgetRejection = await rejectOverBudget(deps, caller, model, newestLength(state.slices));
	if (budgetRejection !== null) {
		return budgetRejection;
	}
	return validateAndForward(state);
}

async function readRequestBody(request: Request): Promise<unknown> {
	try {
		return (await request.json()) as unknown;
	} catch {
		return null;
	}
}

async function rejectMalformed(
	deps: GatewayTurnDeps,
	caller: CallerIdentity,
	errors: string[],
): Promise<Response> {
	await recordTurnAudit(deps, {
		cause: "malformed-request",
		controlId: REQUEST_SHAPE_CONTROL,
		detail: null,
		groupId: caller.groupId,
		model: null,
		promptText: null,
		score: null,
		userId: caller.userId,
		verdict: "block",
	});
	writeDecisionLine({
		blockingControl: REQUEST_SHAPE_CONTROL,
		direction: DECISION_DIRECTION,
		groupId: caller.groupId,
		hits: [],
		outcome: "block",
		timestamp: decisionTimestamp(deps),
		upstream: { outcome: "unknown" },
		userId: caller.userId,
	});
	return openAiError(
		HTTP_BAD_REQUEST,
		`malformed chat completion request: ${errors.join("; ")}`,
		"invalid_request_error",
		"invalid_request",
	);
}

async function rejectMissingModel(
	deps: GatewayTurnDeps,
	caller: CallerIdentity,
): Promise<Response> {
	await recordTurnAudit(deps, {
		cause: "malformed-request",
		controlId: REQUEST_SHAPE_CONTROL,
		detail: null,
		groupId: caller.groupId,
		model: null,
		promptText: null,
		score: null,
		userId: caller.userId,
		verdict: "block",
	});
	writeDecisionLine({
		blockingControl: REQUEST_SHAPE_CONTROL,
		direction: DECISION_DIRECTION,
		groupId: caller.groupId,
		hits: [],
		outcome: "block",
		timestamp: decisionTimestamp(deps),
		upstream: { outcome: "unknown" },
		userId: caller.userId,
	});
	return openAiError(
		HTTP_BAD_REQUEST,
		"request body is missing 'model' and no default model is configured",
		"invalid_request_error",
		"model_required",
	);
}

/**
 * The group must exist in the semantic config too; unknown groups never
 * silently fall back to another group's checks (identity already rejected
 * groups the policy does not define).
 */
async function rejectUnknownSemanticGroup(
	deps: GatewayTurnDeps,
	caller: CallerIdentity,
): Promise<Response | null> {
	try {
		checksForGroup(deps.semanticConfig, caller.groupId);
		return null;
	} catch (error) {
		if (!(error instanceof SemanticConfigurationError)) {
			throw error;
		}
		await recordTurnAudit(deps, {
			cause: "unknown-group",
			controlId: SEMANTIC_CHECKS_CONTROL,
			detail: null,
			groupId: caller.groupId,
			model: null,
			promptText: null,
			score: null,
			userId: caller.userId,
			verdict: "block",
		});
		writeDecisionLine({
			blockingControl: SEMANTIC_CHECKS_CONTROL,
			direction: DECISION_DIRECTION,
			groupId: caller.groupId,
			hits: [],
			outcome: "block",
			timestamp: decisionTimestamp(deps),
			upstream: { outcome: "unknown" },
			userId: caller.userId,
		});
		return openAiError(HTTP_FORBIDDEN, error.message, "permission_error", "unknown-group");
	}
}

function estimatePromptTokens(promptChars: number): number {
	return Math.ceil(promptChars / TOKEN_ESTIMATE_CHARS_PER_TOKEN) + TOKEN_ESTIMATE_OVERHEAD;
}

type BudgetRule = GatewayPolicySnapshot["budget"]["rules"][number];

const PERIOD_SECONDS: Record<BudgetRule["period"], number> = {
	day: SECONDS_PER_DAY,
	hour: SECONDS_PER_HOUR,
	month: SECONDS_PER_DAY * DAYS_PER_MONTH,
};

function periodSeconds(period: BudgetRule["period"]): number {
	return PERIOD_SECONDS[period];
}

/** Rules for this user and model scope. Groups carry no independent limit. */
function applicableBudgetRules(
	budget: GatewayPolicySnapshot["budget"],
	userId: string,
	model: string,
): BudgetRule[] {
	return budget.rules.filter(
		(rule) =>
			rule.key === userId && (rule.modelScope === ALL_MODELS_SCOPE || rule.modelScope === model),
	);
}

function isRuleExhausted(
	rule: BudgetRule,
	spend: SpendSummary,
	promptChars: number,
	price: PriceLookup | null,
): boolean {
	const estimate = estimatePromptTokens(promptChars);
	if (rule.tokens !== undefined && spend.tokens + estimate > rule.tokens) {
		return true;
	}
	const estimated = estimatedCost(price, estimate);
	if (
		rule.costUsd !== undefined &&
		estimated !== null &&
		spend.costUsd + estimated > rule.costUsd
	) {
		return true;
	}
	return false;
}

/**
 * Cost of the estimated prompt tokens at input rates; `null` when the model
 * is unpriced, so cost rules cannot bind — only token-count rules can.
 */
function estimatedCost(price: PriceLookup | null, tokens: number): number | null {
	if (price === null) {
		return null;
	}
	return price.inputPerToken * tokens;
}

async function rejectOverBudget(
	deps: GatewayTurnDeps,
	caller: CallerIdentity,
	model: string,
	promptChars: number,
): Promise<Response | null> {
	const rules = applicableBudgetRules(deps.policy.budget, caller.userId, model);
	if (rules.length === 0) {
		return null;
	}
	const now = deps.clock === undefined ? Date.now() / MS_PER_SECOND : deps.clock();
	const price = deps.priceFor(model);
	for (const rule of rules) {
		// biome-ignore lint/performance/noAwaitInLoops: rules cover different windows, so spend reads stay sequential
		const spend = await Promise.resolve(
			deps.store.spendSince(caller.userId, now - periodSeconds(rule.period)),
		);
		if (!isRuleExhausted(rule, spend, promptChars, price)) {
			continue;
		}
		const verdict = deps.policy.budget.overBudgetVerdict;
		await recordTurnAudit(deps, {
			cause: "budget-exhausted",
			controlId: BUDGET_CONTROL,
			detail: null,
			groupId: caller.groupId,
			model,
			promptText: null,
			score: null,
			userId: caller.userId,
			verdict,
		});
		if (!isBlockingVerdict(verdict)) {
			return null;
		}
		writeDecisionLine({
			blockingControl: BUDGET_CONTROL,
			budget: { outcome: BUDGET_EXHAUSTED_OUTCOME },
			direction: DECISION_DIRECTION,
			groupId: caller.groupId,
			hits: [],
			model,
			outcome: verdict,
			timestamp: decisionTimestamp(deps),
			upstream: { outcome: "unknown" },
			userId: caller.userId,
		});
		return openAiError(
			HTTP_TOO_MANY_REQUESTS,
			`budget exhausted for user "${caller.userId}": over the ${rule.period}ly limit`,
			"insufficient_quota",
			"budget-exhausted",
		);
	}
	return null;
}

/** Validate the newest user turn, then forward (redacted text when redacted). */
async function validateAndForward(state: TurnState): Promise<Response> {
	const promptText = newestText(state.slices);
	const outcome = await guardInteraction(
		{
			content: promptText,
			direction: "inbound",
			groupId: state.caller.groupId,
			id: nextGatewayInteractionId(),
			model: state.model,
			seam: "llm-gateway",
			userId: state.caller.userId,
		},
		state.deps.pipeline,
	);
	if (outcome.rejection !== undefined) {
		return rejectBlocked(state, promptText, outcome.rejection, outcome.inspection);
	}
	const forwardTexts =
		outcome.verdict === "redact"
			? redactedForwardTexts(state.slices, outcome.inspection.redactions)
			: state.slices.map((slice) => slice.text);
	const blocking = outcome.inspection.blockingControl ?? PIPELINE_CONTROL;
	const evidence = evidenceForVerdict(outcome.inspection.hits, outcome.verdict, blocking);
	return forwardUpstream(state, forwardTexts, {
		blockingControl: blocking,
		controlId: evidence.controlId,
		detail: evidence.detail,
		flagged: outcome.inspection.flagged,
		hits: outcome.inspection.hits,
		score: evidence.score,
		verdict: outcome.verdict,
	});
}

interface BlockRejection {
	control: string;
	verdict: Verdict;
}

async function rejectBlocked(
	state: TurnState,
	promptText: string,
	rejection: BlockRejection,
	inspection: InspectionResult,
): Promise<Response> {
	const cause: AuditCause =
		inspection.failure === undefined ? "blocked-by-check" : "classifier-failure";
	const evidence = evidenceForBlocked(inspection, rejection.verdict, rejection.control);
	await recordTurnAudit(state.deps, {
		cause,
		controlId: evidence.controlId,
		detail: evidence.detail,
		groupId: state.caller.groupId,
		model: state.model,
		promptText,
		score: evidence.score,
		userId: state.caller.userId,
		verdict: rejection.verdict,
	});
	writeDecisionLine({
		blockingControl: rejection.control,
		direction: DECISION_DIRECTION,
		flagged: inspection.flagged === true ? true : undefined,
		groupId: state.caller.groupId,
		hits: toDecisionHits(inspection.hits),
		model: state.model,
		outcome: rejection.verdict,
		semanticDetail: evidence.detail ?? undefined,
		timestamp: decisionTimestamp(state.deps),
		upstream: { outcome: "unknown" },
		userId: state.caller.userId,
	});
	const action = rejection.verdict === "escalate" ? "escalated" : "blocked";
	return openAiError(
		HTTP_FORBIDDEN,
		`request ${action} by control "${rejection.control}"`,
		"moderation_error",
		rejection.control,
	);
}

/**
 * Apply detector spans (offsets in the validated newest-turn text) onto that
 * slice only. History messages forward unchanged via index mapping below.
 */
function redactedForwardTexts(
	slices: readonly UserSlice[],
	spans: readonly RedactionSpan[],
): string[] {
	return slices.map((slice) => applyRedactions(slice.text, spans));
}

interface SettleVerdict {
	blockingControl: string;
	controlId: string;
	detail: string | null;
	flagged: boolean;
	hits: readonly ControlHit[];
	score: number | null;
	verdict: Verdict;
}

/**
 * Forward the governed body upstream and stream SSE back. The audit row and
 * the usage row are settled together when the stream ends, so the usage row
 * always links to its audit row; mid-stream aborts still record partial
 * usage with an `upstream-failure` audit row.
 */
async function forwardUpstream(
	state: TurnState,
	forwardTexts: readonly string[],
	settle: SettleVerdict,
): Promise<Response> {
	const forwardBody: Record<string, unknown> = {
		...state.body,
		messages: rebuildMessages(state.body, state.slices, forwardTexts),
		model: state.model,
		stream: true,
	};
	forwardBody[STREAM_OPTIONS_KEY] = { [INCLUDE_USAGE_KEY]: true };
	const events = streamUpstreamCompletion({
		apiKey: state.deps.upstream.apiKey,
		baseUrl: state.deps.upstream.baseUrl,
		body: forwardBody,
		fetchImpl: state.deps.fetchImpl,
		signal: state.deps.request.signal,
	});
	const first = await nextEvent(events);
	if ("error" in first) {
		return rejectUpstreamFailure(state, settle, first.error);
	}
	return streamSettledResponse(state, settle, events, first.result);
}

/** Rebuild the message list with validated (possibly redacted) user text. */
function rebuildMessages(
	body: GatewayChatBody,
	slices: readonly UserSlice[],
	forwardTexts: readonly string[],
): unknown[] {
	const redactedByIndex = new Map(
		slices.map((slice, position) => [slice.index, forwardTexts[position] ?? ""]),
	);
	return body.messages.map((message, index) => {
		const replacement = redactedByIndex.get(index);
		if (replacement === undefined) {
			return message;
		}
		return { ...message, content: replacement };
	});
}

async function rejectUpstreamFailure(
	state: TurnState,
	settle: SettleVerdict,
	error: unknown,
): Promise<Response> {
	const failure = toUpstreamError(error);
	await recordTurnAudit(state.deps, {
		cause: "upstream-failure",
		controlId: settle.controlId,
		detail: settle.detail,
		groupId: state.caller.groupId,
		model: state.model,
		promptText: null,
		score: settle.score,
		userId: state.caller.userId,
		verdict: settle.verdict,
	});
	writeDecisionLine({
		blockingControl: settle.blockingControl,
		direction: DECISION_DIRECTION,
		flagged: settle.flagged === true ? true : undefined,
		groupId: state.caller.groupId,
		hits: toDecisionHits(settle.hits),
		model: state.model,
		outcome: settle.verdict,
		semanticDetail: settle.detail ?? undefined,
		timestamp: decisionTimestamp(state.deps),
		upstream: {
			detail: failure.message,
			outcome: UPSTREAM_FAILURE_OUTCOME,
			status: failure.status,
		},
		userId: state.caller.userId,
	});
	return openAiError(
		HTTP_BAD_GATEWAY,
		`upstream model request failed: ${failure.message}`,
		"server_error",
		"upstream-failure",
	);
}

function toUpstreamError(error: unknown): UpstreamError {
	if (error instanceof UpstreamError) {
		return error;
	}
	if (error instanceof Error) {
		return new UpstreamError(HTTP_BAD_GATEWAY, error.message);
	}
	return new UpstreamError(HTTP_BAD_GATEWAY, String(error));
}

type FirstEvent = { error: unknown } | { result: IteratorResult<string, UpstreamUsage | null> };

async function nextEvent(
	events: AsyncGenerator<string, UpstreamUsage | null, void>,
): Promise<FirstEvent> {
	try {
		return { result: await events.next() };
	} catch (error) {
		return { error };
	}
}

function streamSettledResponse(
	state: TurnState,
	settle: SettleVerdict,
	events: AsyncGenerator<string, UpstreamUsage | null, void>,
	first: IteratorResult<string, UpstreamUsage | null>,
): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const outcome = await relayStream(controller, encoder, events, first);
			await settleStream(state, settle, outcome.usage, outcome.error);
			if (outcome.error !== null) {
				controller.enqueue(encodeFrame(encoder, errorPayload(outcome.error)));
			}
			controller.close();
		},
	});
	return new Response(stream, { headers: sseHeaders(), status: HTTP_OK });
}

interface RelayOutcome {
	error: UpstreamError | null;
	usage: UpstreamUsage | null;
}

async function relayStream(
	controller: ReadableStreamDefaultController<Uint8Array>,
	encoder: TextEncoder,
	events: AsyncGenerator<string, UpstreamUsage | null, void>,
	first: IteratorResult<string, UpstreamUsage | null> | null,
): Promise<RelayOutcome> {
	let current = first;
	let usage: UpstreamUsage | null = null;
	try {
		let streaming = true;
		while (streaming) {
			// biome-ignore lint/performance/noAwaitInLoops: SSE frames arrive sequentially by protocol
			const result = current ?? (await events.next());
			current = null;
			if (result.done) {
				usage = result.value;
				streaming = false;
			} else {
				controller.enqueue(encodeFrame(encoder, result.value));
			}
		}
	} catch (error) {
		return { error: toUpstreamError(error), usage };
	}
	return { error: null, usage };
}

async function settleStream(
	state: TurnState,
	settle: SettleVerdict,
	usage: UpstreamUsage | null,
	error: UpstreamError | null,
): Promise<void> {
	const promptTokens = usage?.promptTokens ?? 0;
	const completionTokens = usage?.completionTokens ?? 0;
	const costUsd = costForUsage(state.deps.priceFor(state.model), promptTokens, completionTokens);
	const auditId = await recordTurnAudit(state.deps, {
		cause: error === null ? null : "upstream-failure",
		controlId: settle.controlId,
		detail: settle.detail,
		groupId: state.caller.groupId,
		model: state.model,
		promptText: null,
		score: settle.score,
		userId: state.caller.userId,
		verdict: settle.verdict,
	});
	await Promise.resolve(
		state.deps.store.recordUsage({
			auditEventId: auditId,
			completionTokens,
			costUsd,
			groupId: state.caller.groupId,
			model: state.model,
			promptTokens,
			userId: state.caller.userId,
		}),
	);
	writeSettledDecisionLine(state, settle, {
		completionTokens,
		costUsd,
		error,
		promptTokens,
	});
}

interface SettledUsage {
	completionTokens: number;
	costUsd: number | null;
	error: UpstreamError | null;
	promptTokens: number;
}

function writeSettledDecisionLine(
	state: TurnState,
	settle: SettleVerdict,
	usage: SettledUsage,
): void {
	if (usage.error === null) {
		writeDecisionLine({
			blockingControl: settle.blockingControl,
			budget: {
				completionTokens: usage.completionTokens,
				costUsd: usage.costUsd,
				outcome: UPSTREAM_OK,
				promptTokens: usage.promptTokens,
			},
			direction: DECISION_DIRECTION,
			flagged: settle.flagged === true ? true : undefined,
			groupId: state.caller.groupId,
			hits: toDecisionHits(settle.hits),
			model: state.model,
			outcome: settle.verdict,
			semanticDetail: settle.detail ?? undefined,
			timestamp: decisionTimestamp(state.deps),
			upstream: { outcome: UPSTREAM_OK, status: HTTP_OK },
			userId: state.caller.userId,
		});
		return;
	}
	writeDecisionLine({
		blockingControl: settle.blockingControl,
		budget: {
			completionTokens: usage.completionTokens,
			costUsd: usage.costUsd,
			outcome: UPSTREAM_OK,
			promptTokens: usage.promptTokens,
		},
		direction: DECISION_DIRECTION,
		flagged: settle.flagged === true ? true : undefined,
		groupId: state.caller.groupId,
		hits: toDecisionHits(settle.hits),
		model: state.model,
		outcome: settle.verdict,
		semanticDetail: settle.detail ?? undefined,
		timestamp: decisionTimestamp(state.deps),
		upstream: {
			detail: usage.error.message,
			outcome: UPSTREAM_FAILURE_OUTCOME,
			status: usage.error.status,
		},
		userId: state.caller.userId,
	});
}

function costForUsage(
	price: PriceLookup | null,
	promptTokens: number,
	completionTokens: number,
): number | null {
	if (price === null) {
		return null;
	}
	return price.inputPerToken * promptTokens + price.outputPerToken * completionTokens;
}

function encodeFrame(encoder: TextEncoder, payload: string): Uint8Array {
	return encoder.encode(`data: ${payload}\n\n`);
}

function errorPayload(error: UpstreamError): string {
	return JSON.stringify({ error: { code: "upstream-failure", message: error.message } });
}

function sseHeaders(): Headers {
	return new Headers({
		"cache-control": "no-cache",
		connection: "keep-alive",
		"content-type": STREAM_CONTENT_TYPE,
	});
}

async function recordTurnAudit(
	deps: GatewayTurnDeps,
	row: Omit<GatewayAuditRow, "policyVersion">,
): Promise<number> {
	return await Promise.resolve(
		deps.store.recordAudit({ ...row, policyVersion: deps.policy.policyVersion }),
	);
}
