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
import type { ControlPipeline, RedactionSpan, Verdict } from "#/control/types.ts";
import { isBlockingVerdict } from "#/control/types.ts";
import type { AuditCause } from "#/db/schema.ts";
import type { PriceLookup } from "#/gateway/pricing.ts";
import type { GatewayAuditRow, GatewayStore, SpendSummary } from "#/gateway/store.ts";
import { createIdSequence } from "#/lib/ids.ts";
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
const PROMPT_SEPARATOR = "\n";
const PIPELINE_CONTROL = "pipeline";
const STREAM_CONTENT_TYPE = "text/event-stream";

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
	slices: UserSlice[];
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
	await recordTurnAudit(deps, {
		cause: missing ? "missing-identity" : "unknown-group",
		controlId: "caller-identity",
		groupId: resolution.groupId ?? "",
		model: null,
		promptText: null,
		score: null,
		userId: resolution.userId ?? "",
		verdict: "block",
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
		return openAiError(
			HTTP_BAD_REQUEST,
			"request body is missing 'model' and no default model is configured",
			"invalid_request_error",
			"model_required",
		);
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
	const budgetRejection = await rejectOverBudget(deps, caller, model, promptLength(state.slices));
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
		controlId: "request-shape",
		groupId: caller.groupId,
		model: null,
		promptText: null,
		score: null,
		userId: caller.userId,
		verdict: "block",
	});
	return openAiError(
		HTTP_BAD_REQUEST,
		`malformed chat completion request: ${errors.join("; ")}`,
		"invalid_request_error",
		"invalid_request",
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
			controlId: "semantic-checks",
			groupId: caller.groupId,
			model: null,
			promptText: null,
			score: null,
			userId: caller.userId,
			verdict: "block",
		});
		return openAiError(HTTP_FORBIDDEN, error.message, "permission_error", "unknown-group");
	}
}

function promptLength(slices: readonly UserSlice[]): number {
	return slices.reduce((total, slice) => total + slice.text.length, 0);
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
			controlId: "budget",
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
		return openAiError(
			HTTP_TOO_MANY_REQUESTS,
			`budget exhausted for user "${caller.userId}": over the ${rule.period}ly limit`,
			"insufficient_quota",
			"budget-exhausted",
		);
	}
	return null;
}

/** Validate the new user content, then forward (redacted text when redacted). */
async function validateAndForward(state: TurnState): Promise<Response> {
	const promptText = state.slices.map((slice) => slice.text).join(PROMPT_SEPARATOR);
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
		return rejectBlocked(state, promptText, outcome.rejection, outcome.inspection.failure);
	}
	const forwardTexts =
		outcome.verdict === "redact"
			? redactSlices(
					state.slices.map((slice) => slice.text),
					outcome.inspection.redactions,
				)
			: state.slices.map((slice) => slice.text);
	return forwardUpstream(state, forwardTexts, {
		controlId: outcome.inspection.blockingControl ?? PIPELINE_CONTROL,
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
	failure: string | undefined,
): Promise<Response> {
	const cause: AuditCause = failure === undefined ? "blocked-by-check" : "classifier-failure";
	await recordTurnAudit(state.deps, {
		cause,
		controlId: rejection.control,
		groupId: state.caller.groupId,
		model: state.model,
		promptText,
		score: null,
		userId: state.caller.userId,
		verdict: rejection.verdict,
	});
	const action = rejection.verdict === "escalate" ? "escalated" : "blocked";
	return openAiError(
		HTTP_FORBIDDEN,
		`request ${action} by control "${rejection.control}"`,
		"moderation_error",
		rejection.control,
	);
}

/** Map blob-level redaction spans back onto their per-message slices. */
function redactSlices(texts: readonly string[], spans: readonly RedactionSpan[]): string[] {
	const slices: string[] = [];
	let cursor = 0;
	for (const text of texts) {
		const start = cursor;
		const end = start + text.length;
		const local = spans.flatMap((span) => clampSpan(span, start, end));
		slices.push(applyRedactions(text, local));
		cursor = end + PROMPT_SEPARATOR.length;
	}
	return slices;
}

function clampSpan(span: RedactionSpan, start: number, end: number): RedactionSpan[] {
	const localStart = Math.max(span.start, start) - start;
	const localEnd = Math.min(span.end, end) - start;
	if (localStart >= localEnd) {
		return [];
	}
	return [{ ...span, end: localEnd, start: localStart }];
}

interface SettleVerdict {
	controlId: string;
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
		return rejectUpstreamFailure(state, first.error);
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

async function rejectUpstreamFailure(state: TurnState, error: unknown): Promise<Response> {
	const failure = toUpstreamError(error);
	await recordTurnAudit(state.deps, {
		cause: "upstream-failure",
		controlId: PIPELINE_CONTROL,
		groupId: state.caller.groupId,
		model: state.model,
		promptText: null,
		score: null,
		userId: state.caller.userId,
		verdict: "allow",
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
	const auditId = await recordTurnAudit(state.deps, {
		cause: error === null ? null : "upstream-failure",
		controlId: settle.controlId,
		groupId: state.caller.groupId,
		model: state.model,
		promptText: null,
		score: null,
		userId: state.caller.userId,
		verdict: settle.verdict,
	});
	await Promise.resolve(
		state.deps.store.recordUsage({
			auditEventId: auditId,
			completionTokens,
			costUsd: costForUsage(state.deps.priceFor(state.model), promptTokens, completionTokens),
			groupId: state.caller.groupId,
			model: state.model,
			promptTokens,
			userId: state.caller.userId,
		}),
	);
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
