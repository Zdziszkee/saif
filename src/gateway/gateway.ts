/**
 * LLM gateway orchestration: the OpenAI-compatible layer agent harnesses
 * point their provider `baseURL` at.
 *
 * Per-request lifecycle (spec order): identity → usage limit → deterministic
 * and semantic gating → forward. Limits run before any tier so an over-limit
 * caller never spends decision-model calls. Gating is inbound-only: model
 * output streams back untouched and uninspected. Exactly one audit event per
 * request — parts are inspected silently, the gateway records the outcome.
 */

import { type AuditSink, auditEvent, noopAuditSink } from "#/control/audit.ts";
import { type GuardOutcome, guardInteraction } from "#/control/guard.ts";
import { type IdentityResolver, identityFromRequest } from "#/control/subjects.ts";
import type { ControlPipeline } from "#/control/types.ts";
import { OUTCOME_SEVERITY } from "#/control/types.ts";
import {
	extractSseUsage,
	extractTextParts,
	type FetchLike,
	openAiError,
	type ParseChatRequest,
	type ProviderUsage,
	parseChatRequest,
	rebuildMessages,
	type TextPart,
} from "./openai.ts";
import { costForModel, type ModelPriceTable } from "./prices.ts";
import { type BudgetRule, checkBudget, type UsageLedger, type UsageRecord } from "./usage.ts";

export interface UpstreamConfig {
	apiKey?: string | undefined;
	baseUrl: string;
}

export interface GatewayDeps {
	audit: AuditSink;
	clock?: () => number;
	fetchImpl?: FetchLike;
	identity: IdentityResolver;
	ledger: UsageLedger;
	pipeline: ControlPipeline;
	policyBudgetRules: readonly BudgetRule[];
	prices: () => Promise<ModelPriceTable | null>;
	upstream: UpstreamConfig | null;
}

interface PartOutcome {
	outcome: "allow" | "block" | "escalate" | "flag" | "redact";
	part: TextPart;
	reason: string;
	redacted?: string | undefined;
	score?: number | undefined;
}

const INTERACTION_ID_PREFIX = "gw";
const TRAILING_SLASH = /\/$/;

let gatewaySequence = 0;

function nextGatewayId(): string {
	gatewaySequence += 1;
	return `${INTERACTION_ID_PREFIX}_${Date.now()}_${gatewaySequence}`;
}

function auditBase(identity: { groupId: string; userId: string }, interactionId: string) {
	return { groupId: identity.groupId, interactionId, userId: identity.userId };
}

interface Denial {
	code: string;
	controlId: string;
	deps: GatewayDeps;
	detail: string;
	identity: { groupId: string; userId: string } | null;
	interactionId: string;
	status: number;
}

function denied(denial: Denial): Response {
	denial.deps.audit.record(
		auditEvent("interaction", {
			...(denial.identity === null ? {} : auditBase(denial.identity, denial.interactionId)),
			controlId: denial.controlId,
			detail: denial.detail,
			seam: "llm-gateway",
			verdict: "block",
		}),
	);
	return Response.json(
		{ ...openAiError(denial.detail, denial.code), interactionId: denial.interactionId },
		{ status: denial.status },
	);
}

function decisiveScore(outcome: GuardOutcome): number | undefined {
	if (outcome.rejection === undefined) {
		return;
	}
	return outcome.inspection.hits.find((hit) => hit.controlId === outcome.rejection?.control)?.score;
}

async function gateParts(input: {
	content: readonly TextPart[];
	deps: GatewayDeps;
	identity: { groupId: string; userId: string };
	interactionId: string;
	model: string | undefined;
}): Promise<{
	outcomes: PartOutcome[];
	verdict: "allow" | "block" | "escalate" | "flag" | "redact";
}> {
	const outcomes: PartOutcome[] = [];
	let verdict: "allow" | "block" | "escalate" | "flag" | "redact" = "allow";
	for (const part of input.content) {
		// biome-ignore lint/performance/noAwaitInLoops: parts gate in order so the first block short-circuits the rest
		const outcome = await guardInteraction(
			{
				content: part.text,
				direction: "inbound",
				groupId: input.identity.groupId,
				id: `${input.interactionId}:part-${part.messageIndex}-${part.partIndex}`,
				model: input.model,
				seam: "llm-gateway",
				userId: input.identity.userId,
			},
			input.deps.pipeline,
			{ audit: noopAuditSink },
		);
		const score = decisiveScore(outcome);
		const partOutcome: PartOutcome = {
			outcome: outcome.verdict === "allow" && outcome.inspection.flagged ? "flag" : outcome.verdict,
			part,
			reason: outcome.rejection
				? `${outcome.rejection.control}: ${outcome.inspection.hits.map((hit) => hit.detail ?? hit.kind).join("; ")}`
				: outcome.inspection.hits.map((hit) => hit.detail ?? hit.kind).join("; "),
			...(outcome.content === undefined ? {} : { redacted: outcome.content }),
			...(score === undefined ? {} : { score }),
		};
		outcomes.push(partOutcome);
		if (OUTCOME_SEVERITY[partOutcome.outcome] > OUTCOME_SEVERITY[verdict]) {
			verdict = partOutcome.outcome;
		}
		if (verdict === "block") {
			break;
		}
	}
	return { outcomes, verdict };
}

function blockedPrompt(outcomes: readonly PartOutcome[]): string {
	return outcomes.map((entry) => entry.part.text).join("\n");
}

function recordUsage(input: {
	completionTokens: number;
	deps: GatewayDeps;
	flaggedParts: number;
	identity: { groupId: string; userId: string };
	interactionId: string;
	model: string;
	promptTokens: number;
	table: ModelPriceTable | null;
}): void {
	const costUsd = costForModel(
		input.table,
		input.model,
		input.promptTokens,
		input.completionTokens,
	);
	const record: UsageRecord = {
		at: new Date((input.deps.clock ?? Date.now)()).toISOString(),
		completionTokens: input.completionTokens,
		costUsd,
		groupId: input.identity.groupId,
		model: input.model,
		promptTokens: input.promptTokens,
		userId: input.identity.userId,
	};
	input.deps.ledger.record(record);
	input.deps.audit.record(
		auditEvent("interaction", {
			...auditBase(input.identity, input.interactionId),
			controlId: "pipeline",
			detail: `usage model=${input.model} prompt=${input.promptTokens} completion=${input.completionTokens} cost=${costUsd === null ? "unknown" : costUsd} flagged=${input.flaggedParts}`,
			seam: "llm-gateway",
			verdict: "allow",
		}),
	);
}

function forwardHeaders(request: Request, upstream: UpstreamConfig): Headers {
	const headers = new Headers({ "content-type": "application/json" });
	const authorization = request.headers.get("authorization");
	if (authorization !== null && authorization.length > 0) {
		headers.set("authorization", authorization);
	} else if (upstream.apiKey !== undefined && upstream.apiKey.length > 0) {
		headers.set("authorization", `Bearer ${upstream.apiKey}`);
	}
	return headers;
}

async function forwardUpstream(
	url: string,
	init: RequestInit,
	deps: GatewayDeps,
): Promise<Response> {
	const fetchImpl: FetchLike = deps.fetchImpl ?? fetch;
	let response: Response;
	try {
		response = await fetchImpl(url, init);
	} catch (error) {
		const detail = `upstream request failed: ${error instanceof Error ? error.message : String(error)}`;
		deps.audit.record(auditEvent("failure", { controlId: "upstream", detail }));
		return Response.json(openAiError(detail, "upstream-failure"), { status: 502 });
	}
	return response;
}

function scanStreamForUsage(
	body: ReadableStream<Uint8Array>,
	onUsage: (usage: { completionTokens: number; promptTokens: number }) => void,
	onError: (error: unknown) => void,
): void {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const pump = (): void => {
		reader
			.read()
			.then(({ done, value }) => {
				if (done) {
					const usage = extractSseUsage(buffer);
					if (usage !== null) {
						onUsage(usage);
					}
					return;
				}
				buffer += decoder.decode(value, { stream: true });
				pump();
			})
			.catch(onError);
	};
	pump();
}

interface GatedDocument {
	document: Record<string, unknown>;
	flaggedParts: number;
	verdict: "allow" | "block" | "escalate" | "flag" | "redact";
}

/** Gate every text part, refuse on block, rebuild redacted messages. */
async function gateRequestBody(input: {
	auditIdentity: { groupId: string; userId: string };
	deps: GatewayDeps;
	document: Record<string, unknown>;
	interactionId: string;
	messages: readonly { content: unknown; role: string }[];
	model: string;
	stream: boolean | undefined;
}): Promise<{ gated: GatedDocument } | { response: Response }> {
	const parts = extractTextParts(input.messages);
	const gated = await gateParts({
		content: parts,
		deps: input.deps,
		identity: input.auditIdentity,
		interactionId: input.interactionId,
		model: input.model,
	});
	if (gated.verdict === "block" || gated.verdict === "escalate") {
		const decisive = gated.outcomes.find((entry) => entry.outcome === gated.verdict);
		const score = decisive?.score === undefined ? "" : ` score=${decisive.score}`;
		const detail =
			`blocked-by-check: ${decisive?.reason ?? gated.verdict}${score}` +
			`\n--- prompt ---\n${blockedPrompt(gated.outcomes)}`;
		return {
			response: denied({
				code: "blocked-by-check",
				controlId: "pipeline",
				deps: input.deps,
				detail,
				identity: input.auditIdentity,
				interactionId: input.interactionId,
				status: 403,
			}),
		};
	}
	const redacted = new Map<string, string>();
	let flaggedParts = 0;
	for (const entry of gated.outcomes) {
		if (entry.outcome === "flag") {
			flaggedParts += 1;
		}
		if (entry.outcome === "redact" && entry.redacted !== undefined) {
			redacted.set(`${entry.part.messageIndex}:${entry.part.partIndex}`, entry.redacted);
		}
	}
	const document = {
		...input.document,
		messages: rebuildMessages(input.messages, redacted),
	} as Record<string, unknown>;
	if (input.stream === true) {
		// biome-ignore lint/complexity/useLiteralKeys: dot access trips noPropertyAccessFromIndexSignature on the index signature
		document["stream_options"] = {
			// biome-ignore lint/style/useNamingConvention: OpenAI wire field, snake_case by external specification
			include_usage: true,
		};
	}
	return { gated: { document, flaggedParts, verdict: gated.verdict } };
}

interface ForwardInput {
	auditIdentity: { groupId: string; userId: string };
	deps: GatewayDeps;
	flaggedParts: number;
	interactionId: string;
	model: string;
	table: ModelPriceTable | null;
	upstream: Response;
	verdict: "allow" | "block" | "escalate" | "flag" | "redact";
}

/** Pipe a streamed completion live while metering usage off a tee branch. */
function forwardStreamed(input: ForwardInput): Promise<Response> {
	if (input.upstream.body === null) {
		return Promise.resolve(
			denied({
				code: "upstream-failure",
				controlId: "upstream",
				deps: input.deps,
				detail: "upstream returned no body",
				identity: input.auditIdentity,
				interactionId: input.interactionId,
				status: 502,
			}),
		);
	}
	const [clientBranch, scanBranch] = input.upstream.body.tee();
	scanStreamForUsage(
		scanBranch,
		(usage) =>
			recordUsage({
				completionTokens: usage.completionTokens,
				deps: input.deps,
				flaggedParts: input.flaggedParts,
				identity: input.auditIdentity,
				interactionId: input.interactionId,
				model: input.model,
				promptTokens: usage.promptTokens,
				table: input.table,
			}),
		(error) =>
			input.deps.audit.record(
				auditEvent("failure", {
					controlId: "upstream",
					detail: `usage scan failed: ${error instanceof Error ? error.message : String(error)}`,
				}),
			),
	);
	input.deps.audit.record(
		auditEvent("interaction", {
			...auditBase(input.auditIdentity, input.interactionId),
			controlId: "pipeline",
			detail: `forwarded model=${input.model} stream=true flagged=${input.flaggedParts}`,
			seam: "llm-gateway",
			verdict: input.verdict === "allow" ? "allow" : "redact",
		}),
	);
	return Promise.resolve(
		new Response(clientBranch, {
			headers: { "content-type": "text/event-stream" },
		}),
	);
}

/** Await a buffered completion, meter it, and pass the provider body through. */
async function forwardBuffered(input: ForwardInput): Promise<Response> {
	let reply: unknown = null;
	try {
		reply = (await input.upstream.json()) as unknown;
	} catch {
		return denied({
			code: "upstream-failure",
			controlId: "upstream",
			deps: input.deps,
			detail: "upstream returned invalid JSON",
			identity: input.auditIdentity,
			interactionId: input.interactionId,
			status: 502,
		});
	}
	const usageRecord = reply as ProviderUsage;
	const promptTokens =
		typeof usageRecord.usage?.prompt_tokens === "number" ? usageRecord.usage.prompt_tokens : 0;
	const completionTokens =
		typeof usageRecord.usage?.completion_tokens === "number"
			? usageRecord.usage.completion_tokens
			: 0;
	recordUsage({
		completionTokens,
		deps: input.deps,
		flaggedParts: input.flaggedParts,
		identity: input.auditIdentity,
		interactionId: input.interactionId,
		model: input.model,
		promptTokens,
		table: input.table,
	});
	return Response.json(reply, { status: input.upstream.status });
}

interface AdmittedRequest {
	identity: { groupId: string; userId: string };
	parsed: ParseChatRequest;
	upstream: UpstreamConfig;
}

/** Shape, identity, budget, and upstream checks in spec order. */
async function admitRequest(
	request: Request,
	deps: GatewayDeps,
	interactionId: string,
): Promise<{ admitted: AdmittedRequest } | { response: Response }> {
	const body = await readGatewayBody(request, deps, interactionId);
	if ("response" in body) {
		return body;
	}
	const caller = resolveGatewayCaller(request, deps, interactionId);
	if ("response" in caller) {
		return caller;
	}
	const auditIdentity = caller.identity;
	const budget = checkBudget({
		model: body.parsed.body.model,
		now: (deps.clock ?? Date.now)(),
		records: deps.ledger.snapshot(),
		rules: deps.policyBudgetRules,
		userId: auditIdentity.userId,
	});
	if (!budget.ok) {
		return {
			response: denied({
				code: "budget-exhausted",
				controlId: "budget",
				deps,
				detail: `budget-exhausted: ${budget.breach.dimension} ${budget.breach.used} >= ${budget.breach.limit}`,
				identity: auditIdentity,
				interactionId,
				status: 403,
			}),
		};
	}
	if (deps.upstream === null) {
		return {
			response: denied({
				code: "upstream-failure",
				controlId: "upstream",
				deps,
				detail: "upstream model provider is not configured",
				identity: auditIdentity,
				interactionId,
				status: 503,
			}),
		};
	}
	return { admitted: { identity: auditIdentity, parsed: body.parsed, upstream: deps.upstream } };
}

async function readGatewayBody(
	request: Request,
	deps: GatewayDeps,
	interactionId: string,
): Promise<{ parsed: ParseChatRequest } | { response: Response }> {
	let raw: unknown = null;
	try {
		raw = await request.json();
	} catch {
		return {
			response: denied({
				code: "malformed",
				controlId: "shape",
				deps,
				detail: "malformed request: expected a JSON object",
				identity: null,
				interactionId,
				status: 400,
			}),
		};
	}
	const parsed = parseChatRequest(raw);
	if ("errors" in parsed) {
		return {
			response: denied({
				code: "malformed",
				controlId: "shape",
				deps,
				detail: `malformed request: ${parsed.errors.join("; ")}`,
				identity: null,
				interactionId,
				status: 400,
			}),
		};
	}
	return { parsed };
}

function resolveGatewayCaller(
	request: Request,
	deps: GatewayDeps,
	interactionId: string,
): { identity: { groupId: string; userId: string } } | { response: Response } {
	const presented = identityFromRequest(request);
	const resolution = deps.identity.resolve(presented.userId, presented.groupId);
	if (!resolution.ok) {
		const cause = resolution.kind === "unknown-group" ? "unknown-group" : "missing-identity";
		return {
			response: denied({
				code: cause,
				controlId: "caller-identity",
				deps,
				detail: `${cause}: ${resolution.reason}`,
				identity: null,
				interactionId,
				status: 403,
			}),
		};
	}
	const identity = resolution.identity;
	return { identity: { groupId: identity.groupId, userId: identity.userId } };
}
export async function handleChatCompletions(
	request: Request,
	deps: GatewayDeps,
): Promise<Response> {
	const interactionId = nextGatewayId();
	const admission = await admitRequest(request, deps, interactionId);
	if ("response" in admission) {
		return admission.response;
	}

	const settled = await gateRequestBody({
		auditIdentity: admission.admitted.identity,
		deps,
		document: admission.admitted.parsed.document,
		interactionId,
		messages: admission.admitted.parsed.body.messages,
		model: admission.admitted.parsed.body.model,
		stream: admission.admitted.parsed.body.stream,
	});
	if ("response" in settled) {
		return settled.response;
	}

	const upstream = await forwardUpstream(
		`${admission.admitted.upstream.baseUrl.replace(TRAILING_SLASH, "")}/chat/completions`,
		{
			body: JSON.stringify(settled.gated.document),
			headers: forwardHeaders(request, admission.admitted.upstream),
			method: "POST",
		},
		deps,
	);
	if (!upstream.ok) {
		const detail = `upstream provider replied ${upstream.status}`;
		deps.audit.record(
			auditEvent("interaction", {
				...auditBase(admission.admitted.identity, interactionId),
				controlId: "upstream",
				detail,
				seam: "llm-gateway",
				verdict: "block",
			}),
		);
		return Response.json(openAiError(detail, "upstream-failure"), { status: upstream.status });
	}

	const table = await deps.prices();
	const onward = {
		auditIdentity: admission.admitted.identity,
		deps,
		flaggedParts: settled.gated.flaggedParts,
		interactionId,
		model: admission.admitted.parsed.body.model,
		table,
		upstream,
		verdict: settled.gated.verdict,
	};
	return admission.admitted.parsed.body.stream === true
		? forwardStreamed(onward)
		: forwardBuffered(onward);
}
