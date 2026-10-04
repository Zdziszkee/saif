// biome-ignore-all lint/style/useNamingConvention: OpenAI wire-format keys are snake_case by specification.
/**
 * OpenAI-compatible chat-completions gateway (`POST /v1/chat/completions`).
 *
 * The prompt-plane gateway seam: caller identity from `x-user-id` /
 * `x-user-group-id`, OpenAI chat-completions schema validation first
 * (malformed or oversized requests are rejected and recorded before any
 * control evaluation), then the defined lifecycle — identity, usage-limit
 * pre-check, deterministic + semantic tiers via the shared hub pipeline,
 * upstream forward.
 *
 * Identity and shape rejections mirror the guard API exactly (same 403
 * identity cause shape, same 400 malformed shape, zero control evaluation
 * on either). An over-limit caller short-circuits with 429 before any tier
 * runs. Non-stream completions answer with OpenAI JSON and settle a usage
 * row `{userId, groupId, model, tokens, costUsd}` onward (audit record plus
 * the `onUsage` hook — never written to the database here; durable
 * settlement belongs to the budget/usage worker's repos). Streaming
 * completions relay the upstream SSE body through unchanged: no buffering,
 * no answer inspection, so streamed tokens are never governed mid-flight —
 * the prompt side still is, before the relay opens.
 */

import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { type AuditSink, auditEvent, noopAuditSink } from "#/control/audit.ts";
import { guardInteraction, rejectionKind } from "#/control/guard.ts";
import { createPriceTable, type PriceTable } from "#/control/pricing.ts";
import { checksForGroup, SEMANTIC_DEFAULTS } from "#/control/semantic/config.ts";
import { MAX_CONTENT_LENGTH } from "#/control/shape.ts";
import {
	type CallerIdentity,
	type IdentityResolver,
	identityFromRequest,
	identityRejection,
} from "#/control/subjects.ts";
import type { ControlPipeline, Interaction } from "#/control/types.ts";
import { env } from "#/env.ts";
import {
	createOpenAICompatibleConnection,
	ModelConfigurationError,
	type ModelMessage,
	type ModelReply,
} from "#/hub/model.ts";
import { getHub } from "#/hub/runtime.ts";
import { describeError } from "#/lib/errors.ts";
import { createIdSequence } from "#/lib/ids.ts";

const MAX_MESSAGES = 256;
const MAX_MODEL_FIELD_LENGTH = 256;
const MAX_NAME_FIELD_LENGTH = 128;
const MS_PER_SECOND = 1000;
const TRAILING_SLASH = /\/$/;
const HTTP_BAD_GATEWAY = 502;
const HTTP_SERVICE_UNAVAILABLE = 503;

const textPartSchema = z.object({
	text: z.string().min(1),
	type: z.literal("text"),
});

const chatMessageSchema = z.object({
	content: z.union([z.string(), z.array(textPartSchema).min(1)]),
	name: z.string().min(1).max(MAX_NAME_FIELD_LENGTH).optional(),
	role: z.enum(["assistant", "system", "tool", "user"]),
});

const chatCompletionsSchema = z.object({
	max_tokens: z.number().int().positive().optional(),
	messages: z.array(chatMessageSchema).min(1).max(MAX_MESSAGES),
	model: z.string().min(1).max(MAX_MODEL_FIELD_LENGTH).optional(),
	stream: z.boolean().optional(),
	temperature: z.number().min(0).max(2).optional(),
	top_p: z.number().min(0).max(1).optional(),
});

type ChatCompletionsBody = z.infer<typeof chatCompletionsSchema>;

export type UsageCheckResult = { ok: true } | { ok: false; reason: string };

/**
 * Pre-flight usage-limit check. Async so a future ledger-backed checker can
 * plug in; injected so tests decide the verdict. Absent, every caller is
 * allowed through.
 */
export interface ChatCompletionsUsageChecker {
	checkUsage(identity: CallerIdentity): Promise<UsageCheckResult>;
}

/** Settled usage row, built on completion and handed onward for settlement. */
export interface GatewayUsageRow {
	completionTokens: number;
	costUsd: number | null;
	groupId: string;
	model: string;
	promptTokens: number;
	totalTokens: number;
	userId: string;
}

export interface ChatCompletionsGatewayDeps {
	apiKey?: string | undefined;
	audit?: AuditSink | undefined;
	baseUrl?: string | undefined;
	identity: IdentityResolver;
	modelName?: string | undefined;
	/** Settlement hook receiving every completed usage row (not DB-backed here). */
	onUsage?: ((row: GatewayUsageRow) => void) | undefined;
	pipeline: ControlPipeline;
	priceTable?: PriceTable | undefined;
	/**
	 * Group-selected semantic question sets, via the existing semantic group
	 * mapping by default. Same content under two groups resolves to each
	 * group's own question set — never another group's.
	 */
	semanticChecksForGroup?: ((groupId: string) => readonly string[]) | undefined;
	upstreamFetch?: typeof fetch | undefined;
	usageLimit?: ChatCompletionsUsageChecker | undefined;
}

const nextGatewayInteractionId = createIdSequence("gateway");
const nextCompletionId = createIdSequence("chatcmpl");

/** Default mapping: the shipped semantic config's per-group check ids. */
function defaultQuestionsForGroup(groupId: string): readonly string[] {
	try {
		return checksForGroup(SEMANTIC_DEFAULTS, groupId).map((check) => check.id);
	} catch {
		// The semantic document does not list this policy group: evaluate the
		// full enabled set (strict) rather than borrowing another group's scope.
		return SEMANTIC_DEFAULTS.checks.filter((check) => check.enabled).map((check) => check.id);
	}
}

export async function handleChatCompletions(
	request: Request,
	deps: ChatCompletionsGatewayDeps,
): Promise<Response> {
	const audit = deps.audit ?? noopAuditSink;

	const presented = identityFromRequest(request);
	const resolution = deps.identity.resolve(presented.userId, presented.groupId);
	if (!resolution.ok) {
		return identityRejection(resolution, audit);
	}
	const identity = resolution.identity;

	const parsed = await parseGatewayBody(request, audit, identity, deps.modelName);
	if (!parsed.ok) {
		return parsed.response;
	}
	const endpoint = requireEndpoint(deps.baseUrl);
	if (endpoint === undefined) {
		return modelUnavailable();
	}
	const refusal = await enforceUsageLimit(deps.usageLimit, identity, audit);
	if (refusal !== undefined) {
		return refusal;
	}
	return runGovernedCompletion({
		apiKey: deps.apiKey,
		audit,
		endpoint,
		fetchFn: deps.upstreamFetch ?? fetch,
		identity,
		onUsage: deps.onUsage,
		parsed,
		pipeline: deps.pipeline,
		priceTable: deps.priceTable,
		semanticChecksForGroup: deps.semanticChecksForGroup,
	});
}

interface GovernedCompletionScope {
	apiKey: string | undefined;
	audit: AuditSink;
	endpoint: string;
	fetchFn: typeof fetch;
	identity: CallerIdentity;
	onUsage: ((row: GatewayUsageRow) => void) | undefined;
	parsed: ParsedGatewayRequest;
	pipeline: ControlPipeline;
	priceTable: PriceTable | undefined;
	semanticChecksForGroup: ((groupId: string) => readonly string[]) | undefined;
}

async function runGovernedCompletion(scope: GovernedCompletionScope): Promise<Response> {
	const questionIds = (scope.semanticChecksForGroup ?? defaultQuestionsForGroup)(
		scope.identity.groupId,
	);
	scope.audit.record(
		auditEvent("interaction", {
			consumerKey: scope.identity.userId,
			controlId: "semantic-scope",
			detail: `semantic questions for group ${scope.identity.groupId}: ${questionIds.join(", ") || "(none)"}`,
			groupId: scope.identity.groupId,
			userId: scope.identity.userId,
		}),
	);

	const guarded = await guardPrompt({
		audit: scope.audit,
		body: scope.parsed.body,
		identity: scope.identity,
		model: scope.parsed.model,
		pipeline: scope.pipeline,
		raw: scope.parsed.raw,
		texts: scope.parsed.texts,
	});
	if (!guarded.ok) {
		return guarded.response;
	}

	const forward: ForwardContext = {
		apiKey: scope.apiKey,
		audit: scope.audit,
		baseUrl: scope.endpoint,
		fetchFn: scope.fetchFn,
	};
	const completion: CompletionRequest = {
		forwardMessages: guarded.forwardMessages,
		identity: scope.identity,
		model: scope.parsed.model,
		questionIds,
	};
	if (scope.parsed.body.stream === true) {
		return relayStream({ ...completion, body: scope.parsed.body }, forward);
	}
	return completeJson(completion, {
		...forward,
		onUsage: scope.onUsage,
		pipeline: scope.pipeline,
		priceTable: scope.priceTable,
	});
}

interface ParsedGatewayRequest {
	body: ChatCompletionsBody;
	model: string;
	raw: unknown;
	texts: string[];
}

type ParsedGatewayBody = { ok: false; response: Response } | ({ ok: true } & ParsedGatewayRequest);

/** Schema validation first: malformed or oversized bodies never reach a tier. */
async function parseGatewayBody(
	request: Request,
	audit: AuditSink,
	identity: CallerIdentity,
	defaultModel: string | undefined,
): Promise<ParsedGatewayBody> {
	const raw: unknown = await request.json().catch((): unknown => null);
	const parsed = chatCompletionsSchema.safeParse(raw);
	if (!parsed.success) {
		return {
			ok: false,
			response: malformedRequest(audit, identity, parsed.error.issues.map(describeIssue)),
		};
	}
	const body = parsed.data;
	const model = body.model ?? defaultModel;
	if (model === undefined) {
		return {
			ok: false,
			response: malformedRequest(audit, identity, [
				"model: required when the gateway has no default model",
			]),
		};
	}
	const texts = body.messages.map(messageText);
	const joined = texts.join("\n");
	if (joined.length > MAX_CONTENT_LENGTH) {
		return {
			ok: false,
			response: malformedRequest(audit, identity, [
				`content: oversized (${joined.length} chars exceeds the ${MAX_CONTENT_LENGTH} limit)`,
			]),
		};
	}
	return { body, model, ok: true, raw, texts };
}

function requireEndpoint(baseUrl: string | undefined): string | undefined {
	return baseUrl;
}

function modelUnavailable(): Response {
	return Response.json(
		{
			control: "model-connection",
			error: "unavailable",
			reason: "model connection is not configured: set MODEL_BASE_URL and MODEL_NAME",
		},
		{ status: 503 },
	);
}

/** Over-limit callers short-circuit before any tier runs. */
async function enforceUsageLimit(
	checker: ChatCompletionsUsageChecker | undefined,
	identity: CallerIdentity,
	audit: AuditSink,
): Promise<Response | undefined> {
	if (checker === undefined) {
		return;
	}
	const decision = await checker.checkUsage(identity);
	if (decision.ok) {
		return;
	}
	audit.record(
		auditEvent("budget", {
			consumerKey: identity.userId,
			controlId: "usage-limit",
			detail: `usage limit rejected: ${decision.reason}`,
			groupId: identity.groupId,
			userId: identity.userId,
			verdict: "block",
		}),
	);
	return Response.json(
		{
			control: "usage-limit",
			error: "over_limit",
			reason: decision.reason,
			verdict: "block",
		},
		{ status: 429 },
	);
}

function describeIssue(issue: z.ZodIssue): string {
	const path = issue.path.length > 0 ? issue.path.join(".") : "request";
	return `${path}: ${issue.message}`;
}

function malformedRequest(audit: AuditSink, identity: CallerIdentity, errors: string[]): Response {
	audit.record(
		auditEvent("interaction", {
			consumerKey: identity.userId,
			detail: `malformed request rejected: ${errors.join("; ")}`,
			groupId: identity.groupId,
			userId: identity.userId,
		}),
	);
	return Response.json({ details: errors, error: "malformed_request" }, { status: 400 });
}

function messageText(message: z.infer<typeof chatMessageSchema>): string {
	return typeof message.content === "string"
		? message.content
		: message.content.map((part) => part.text).join("");
}

interface PromptScope {
	audit: AuditSink;
	body: ChatCompletionsBody;
	identity: CallerIdentity;
	model: string;
	pipeline: ControlPipeline;
	raw: unknown;
	texts: string[];
}

type GuardedPrompt = { forwardMessages: unknown[]; ok: true } | { ok: false; response: Response };

/**
 * Guard every prompt message inbound through the shared pipeline. The
 * original (pre-governance) content never reaches the model: `allow`
 * forwards the message untouched, `redact` forwards the governed text,
 * `block`/`escalate` refuse with the defined rejection shape.
 */
async function guardPrompt(scope: PromptScope): Promise<GuardedPrompt> {
	const rawMessages = (scope.raw as { messages: Record<string, unknown>[] }).messages;
	const forwardMessages: unknown[] = [];
	for (let index = 0; index < scope.body.messages.length; index += 1) {
		const message = scope.body.messages[index];
		if (message === undefined) {
			continue;
		}
		const text = scope.texts[index] ?? "";
		// biome-ignore lint/performance/noAwaitInLoops: prompt messages govern in order, each audited
		const outcome = await guardInteraction(
			{
				content: text,
				direction: "inbound",
				groupId: scope.identity.groupId,
				id: nextGatewayInteractionId(),
				model: scope.model,
				seam: "chat",
				userId: scope.identity.userId,
			} satisfies Interaction,
			scope.pipeline,
			{ audit: scope.audit, consumerKey: scope.identity.userId },
		);
		if (outcome.rejection !== undefined) {
			return {
				ok: false,
				response: Response.json(
					{
						control: outcome.rejection.control,
						error: rejectionKind(outcome.verdict),
						verdict: outcome.verdict,
					},
					{ status: outcome.rejection.status },
				),
			};
		}
		const rawMessage = rawMessages[index] ?? {};
		forwardMessages.push(
			outcome.verdict === "redact"
				? { ...(rawMessage as Record<string, unknown>), content: outcome.content ?? text }
				: rawMessage,
		);
	}
	return { forwardMessages, ok: true };
}

interface ForwardContext {
	apiKey: string | undefined;
	audit: AuditSink;
	baseUrl: string;
	fetchFn: typeof fetch;
}

interface CompletionRequest {
	forwardMessages: unknown[];
	identity: CallerIdentity;
	model: string;
	questionIds: readonly string[];
}

interface JsonCompletionContext extends ForwardContext {
	onUsage: ((row: GatewayUsageRow) => void) | undefined;
	pipeline: ControlPipeline;
	priceTable: PriceTable | undefined;
}

type UpstreamCompletion = { ok: false; response: Response } | { ok: true; reply: ModelReply };

async function completeJson(
	completion: CompletionRequest,
	context: JsonCompletionContext,
): Promise<Response> {
	const messages: ModelMessage[] = completion.forwardMessages.map(toModelMessage);
	const upstream = await requestUpstreamCompletion(messages, completion, context);
	if (!upstream.ok) {
		return upstream.response;
	}

	const answerOutcome = await guardInteraction(
		{
			content: upstream.reply.text,
			direction: "outbound",
			groupId: completion.identity.groupId,
			id: nextGatewayInteractionId(),
			model: completion.model,
			seam: "chat",
			userId: completion.identity.userId,
		} satisfies Interaction,
		context.pipeline,
		{ audit: context.audit, consumerKey: completion.identity.userId },
	);

	// Tokens were spent upstream even when the answer is refused: settle first.
	const row = await settleUsage({ ...completion, reply: upstream.reply }, context);
	if (answerOutcome.rejection !== undefined) {
		return Response.json(
			{
				control: answerOutcome.rejection.control,
				error: rejectionKind(answerOutcome.verdict),
				verdict: answerOutcome.verdict,
			},
			{ status: answerOutcome.rejection.status },
		);
	}

	return Response.json({
		choices: [
			{
				finish_reason: upstream.reply.finishReason,
				index: 0,
				message: { content: answerOutcome.content ?? upstream.reply.text, role: "assistant" },
			},
		],
		created: Math.floor(Date.now() / MS_PER_SECOND),
		id: nextCompletionId(),
		model: completion.model,
		object: "chat.completion",
		usage: {
			completion_tokens: row.completionTokens,
			prompt_tokens: row.promptTokens,
			total_tokens: row.totalTokens,
		},
	});
}

/** Non-stream forward through the hub's OpenAI-compatible connection. */
async function requestUpstreamCompletion(
	messages: ModelMessage[],
	completion: CompletionRequest,
	context: JsonCompletionContext,
): Promise<UpstreamCompletion> {
	let reply: ModelReply;
	try {
		const connection = createOpenAICompatibleConnection({
			...(context.apiKey === undefined ? {} : { apiKey: context.apiKey }),
			baseUrl: context.baseUrl,
			fetch: context.fetchFn,
			modelName: completion.model,
		});
		reply = await connection.complete({ messages });
	} catch (error) {
		const unavailable = error instanceof ModelConfigurationError;
		context.audit.record(
			auditEvent("failure", {
				consumerKey: completion.identity.userId,
				controlId: "model-upstream",
				detail: describeError(error),
				groupId: completion.identity.groupId,
				userId: completion.identity.userId,
				verdict: "block",
			}),
		);
		return {
			ok: false,
			response: Response.json(
				{
					control: "model-upstream",
					error: unavailable ? "unavailable" : "upstream_error",
					reason: describeError(error),
				},
				{ status: unavailable ? HTTP_SERVICE_UNAVAILABLE : HTTP_BAD_GATEWAY },
			),
		};
	}
	return { ok: true, reply };
}

function toModelMessage(message: unknown): ModelMessage {
	const record = message as { content?: unknown; role?: unknown };
	const content =
		typeof record.content === "string" ? record.content : JSON.stringify(record.content ?? "");
	const role =
		record.role === "assistant" || record.role === "system" || record.role === "tool"
			? record.role
			: "user";
	return { content, role };
}

interface SettledCompletion extends CompletionRequest {
	reply: ModelReply;
}

/**
 * Build the settlement row, price it (cost `null` when unpriced), and hand
 * it onward via the audit record and the `onUsage` hook. The row is
 * returned, never stored: durable settlement is the budget worker's repo.
 */
async function settleUsage(
	completion: SettledCompletion,
	context: JsonCompletionContext,
): Promise<GatewayUsageRow> {
	await context.priceTable?.refresh();
	const row: GatewayUsageRow = {
		completionTokens: completion.reply.usage.completionTokens,
		costUsd:
			context.priceTable === undefined
				? null
				: context.priceTable.costFor(completion.model, {
						completionTokens: completion.reply.usage.completionTokens,
						promptTokens: completion.reply.usage.promptTokens,
					}),
		groupId: completion.identity.groupId,
		model: completion.model,
		promptTokens: completion.reply.usage.promptTokens,
		totalTokens: completion.reply.usage.totalTokens,
		userId: completion.identity.userId,
	};
	context.audit.record(
		auditEvent("budget", {
			consumerKey: completion.identity.userId,
			controlId: "usage-accounting",
			detail: `usage settled for ${completion.questionIds.length} question(s): ${JSON.stringify(row)}`,
			groupId: completion.identity.groupId,
			userId: completion.identity.userId,
			verdict: "allow",
		}),
	);
	context.onUsage?.(row);
	return row;
}

interface StreamCompletionRequest extends CompletionRequest {
	body: ChatCompletionsBody;
}

interface UpstreamChatBody {
	max_tokens?: number | undefined;
	messages: unknown[];
	model: string;
	stream: boolean;
	temperature?: number | undefined;
	top_p?: number | undefined;
}

/**
 * Stream relay: the governed prompt goes upstream with `stream: true` and
 * the SSE body pipes straight to the caller. The stream is never buffered
 * or inspected — what the provider sends is what the caller receives, in
 * order — so streamed answers skip the outbound tier by design.
 */
async function relayStream(
	completion: StreamCompletionRequest,
	context: ForwardContext,
): Promise<Response> {
	const upstreamBody: UpstreamChatBody = {
		...(completion.body.max_tokens === undefined ? {} : { max_tokens: completion.body.max_tokens }),
		...(completion.body.temperature === undefined
			? {}
			: { temperature: completion.body.temperature }),
		...(completion.body.top_p === undefined ? {} : { top_p: completion.body.top_p }),
		messages: completion.forwardMessages,
		model: completion.model,
		stream: true,
	};
	const opened = await openUpstreamStream(upstreamBody, completion.identity, context);
	if (!opened.ok) {
		return opened.response;
	}
	context.audit.record(
		auditEvent("interaction", {
			consumerKey: completion.identity.userId,
			controlId: "pipeline",
			detail: `stream relay opened for model ${completion.model} (${completion.questionIds.length} question(s))`,
			groupId: completion.identity.groupId,
			userId: completion.identity.userId,
			verdict: "allow",
		}),
	);
	return new Response(opened.upstream.body, {
		headers: {
			"cache-control": "no-cache",
			connection: "keep-alive",
			"content-type": "text/event-stream; charset=utf-8",
			"x-accel-buffering": "no",
		},
	});
}

type OpenedStream = { ok: false; response: Response } | { ok: true; upstream: Response };

async function openUpstreamStream(
	upstreamBody: UpstreamChatBody,
	identity: CallerIdentity,
	context: ForwardContext,
): Promise<OpenedStream> {
	let upstream: Response;
	try {
		upstream = await context.fetchFn(
			`${context.baseUrl.replace(TRAILING_SLASH, "")}/chat/completions`,
			{
				body: JSON.stringify(upstreamBody),
				headers: {
					"content-type": "application/json",
					...(context.apiKey === undefined ? {} : { authorization: `Bearer ${context.apiKey}` }),
				},
				method: "POST",
			},
		);
	} catch (error) {
		return { ok: false, response: upstreamError(identity, context.audit, describeError(error)) };
	}
	if (!upstream.ok) {
		return {
			ok: false,
			response: upstreamError(
				identity,
				context.audit,
				`model endpoint returned HTTP ${upstream.status}`,
			),
		};
	}
	return { ok: true, upstream };
}

function upstreamError(identity: CallerIdentity, audit: AuditSink, reason: string): Response {
	audit.record(
		auditEvent("failure", {
			consumerKey: identity.userId,
			controlId: "model-upstream",
			detail: reason,
			groupId: identity.groupId,
			userId: identity.userId,
			verdict: "block",
		}),
	);
	return Response.json(
		{ control: "model-upstream", error: "upstream_error", reason },
		{ status: HTTP_BAD_GATEWAY },
	);
}

/**
 * Windowed usage tracker: the in-memory enforcement hook behind the
 * pre-flight `usageLimit` check and the post-completion settlement row.
 *
 * Tokens are counted per user id (the unit of usage limiting) inside a
 * fixed window; the first touch past the window edge opens a fresh one
 * (rollover). One user's spend never affects another's. The clock is
 * injectable so rollover is deterministic under test.
 */
export interface WindowedUsageOptions {
	limitTokens: number;
	now?: (() => number) | undefined;
	windowMs: number;
}

export interface WindowedUsageTracker extends ChatCompletionsUsageChecker {
	recordUsage(row: GatewayUsageRow): void;
	usageOf(userId: string): number;
}

interface UsageWindow {
	startedAt: number;
	tokens: number;
}

export function createWindowedUsageTracker(options: WindowedUsageOptions): WindowedUsageTracker {
	const now = options.now ?? Date.now;
	const windows = new Map<string, UsageWindow>();

	function current(userId: string): UsageWindow {
		const timestamp = now();
		const entry = windows.get(userId);
		if (entry === undefined || timestamp - entry.startedAt >= options.windowMs) {
			const fresh: UsageWindow = { startedAt: timestamp, tokens: 0 };
			windows.set(userId, fresh);
			return fresh;
		}
		return entry;
	}

	return {
		checkUsage: (identity) => {
			const used = current(identity.userId).tokens;
			return Promise.resolve<UsageCheckResult>(
				used >= options.limitTokens
					? {
							ok: false,
							reason: `usage limit exceeded: ${used}/${options.limitTokens} tokens in window`,
						}
					: { ok: true },
			);
		},
		recordUsage: (row) => {
			current(row.userId).tokens += row.totalTokens;
		},
		usageOf: (userId) => current(userId).tokens,
	};
}

let sharedPriceTable: PriceTable | undefined;

/** Process-wide table: fetch-once, then TTL-cached across gateway requests. */
function getSharedPriceTable(): PriceTable {
	sharedPriceTable ??= createPriceTable();
	return sharedPriceTable;
}

async function handleGatewayRequest(request: Request): Promise<Response> {
	const hub = await getHub();
	return handleChatCompletions(request, {
		apiKey: env.MODEL_API_KEY,
		audit: hub.audit,
		baseUrl: env.MODEL_BASE_URL,
		identity: hub.identity,
		modelName: env.MODEL_NAME,
		pipeline: hub.pipeline,
		priceTable: getSharedPriceTable(),
	});
}

export const Route = createFileRoute("/v1/chat-completions")({
	server: {
		handlers: {
			POST: ({ request }) => handleGatewayRequest(request),
		},
	},
});
