/**
 * Tool-call governance at the hub: every tool call — hub-hosted or from a
 * connected MCP server — is grant-checked, confirmation-gated when the tool
 * policy demands it, its arguments are inspected before execution (redacted
 * arguments execute redacted), and its result is inspected before being
 * returned. Blocked calls do not execute and are audited.
 *
 * Confirmation protocol (per-tool `requireConfirm` in `policy.mcp.json`):
 * the first call returns `confirmation-required` with an opaque token and
 * executes nothing; the caller repeats the call with `{ ..., "confirm": token }`
 * to execute the originally proposed arguments. Tokens are single-use,
 * group-bound, and expire after five minutes. The stored arguments run — not
 * the confirming call's — so approval cannot be re-targeted at new arguments.
 */

import { type AuditSink, auditEvent, noopAuditSink } from "#/control/audit.ts";
import { type GuardRejection, guardInteraction, rejectionKind } from "#/control/guard.ts";
import type { ControlPipeline, Verdict } from "#/control/types.ts";
import { describeError } from "#/lib/errors.ts";
import { parseJsonOrEmpty, parseJsonOrForward } from "#/lib/json.ts";
import type { CatalogEntry } from "./catalog.ts";
import type { GrantRegistry } from "./grants.ts";
import type { ToolAccessPolicy } from "./tool-policy.ts";
import type { ToolUsageRecord } from "./tool-usage.ts";

export interface ToolRejection {
	control: string;
	kind: "blocked" | "denied" | "escalated" | "failed";
	verdict: Verdict;
}

/** Issued instead of executing: present `token` as `confirm` to proceed. */
export interface ConfirmationRequest {
	token: string;
	tool: string;
}

export type ToolCallOutcome =
	| { confirmation: ConfirmationRequest; kind: "confirmation-required" }
	| { kind: "executed"; result: unknown; resultVerdict: Verdict }
	| { kind: "refused"; rejection: ToolRejection };

/** The defined payload returned to callers in place of tool output. */
export function definedRejection(rejection: ToolRejection): string {
	return JSON.stringify({
		control: rejection.control,
		error: rejection.kind,
		verdict: rejection.verdict,
	});
}

/** The defined payload asking the caller to confirm before the tool runs. */
export function definedConfirmation(confirmation: ConfirmationRequest): string {
	return JSON.stringify({
		confirmationToken: confirmation.token,
		control: "tool-confirmation",
		error: "confirmation-required",
		tool: confirmation.tool,
		verdict: "escalate",
	});
}

/** Durable-usage hook: every terminal tool-call outcome is reported here. */
export type ToolUsageSink = (record: ToolUsageRecord) => void;

export interface GovernorOptions {
	access?: ToolAccessPolicy | undefined;
	audit?: AuditSink | undefined;
	grants: GrantRegistry;
	pipeline: ControlPipeline;
	usage?: ToolUsageSink | undefined;
}

export interface ToolGovernor {
	governToolCall(
		entry: CatalogEntry,
		args: unknown,
		groupId: string,
		consumerKey?: string,
	): Promise<ToolCallOutcome>;
}

interface PendingConfirmation {
	args: unknown;
	entry: CatalogEntry;
	expiresAt: number;
	groupId: string;
}

interface GovernorDeps {
	access: ToolAccessPolicy | undefined;
	audit: AuditSink;
	grants: GrantRegistry;
	pending: Map<string, PendingConfirmation>;
	pipeline: ControlPipeline;
	usage: ToolUsageSink | undefined;
}

type PhaseResult =
	| { rejection: ToolRejection; value?: undefined }
	| { rejection?: undefined; value: unknown };

const CONFIRM_TTL_MS = 300_000;
const CHARS_PER_TOKEN_ESTIMATE = 4;

export function createToolGovernor(options: GovernorOptions): ToolGovernor {
	const deps: GovernorDeps = {
		access: options.access,
		audit: options.audit ?? noopAuditSink,
		grants: options.grants,
		pending: new Map(),
		pipeline: options.pipeline,
		usage: options.usage,
	};
	return {
		governToolCall: (entry, args, groupId, consumerKey) =>
			governToolCall(entry, args, groupId, deps, consumerKey),
	};
}

// biome-ignore lint/complexity/useMaxParams lint/suspicious/useAwait: positional phase args; async required by ToolGovernor, awaits live in runInspectedCall
async function governToolCall(
	entry: CatalogEntry,
	args: unknown,
	groupId: string,
	deps: GovernorDeps,
	consumerKey?: string,
): Promise<ToolCallOutcome> {
	const startedAt = Date.now();
	const usageBase = {
		argsSize: argsSizeOf(args),
		entry,
		groupId,
		startedAt,
		userId: userIdOf(consumerKey),
	};

	const denial = checkGrant(entry, groupId, deps, consumerKey);
	if (denial) {
		reportUsage(deps, { ...usageBase, controlId: denial.control, verdict: denial.verdict });
		return { kind: "refused", rejection: denial };
	}

	const confirmation = checkConfirmation(entry, args, groupId, deps, consumerKey);
	const requireConfirm = deps.access?.requiresConfirm(entry.name) ?? false;
	const confirmed = requireConfirm ? confirmation.confirmed : undefined;
	if (confirmation.pending) {
		reportUsage(deps, {
			...usageBase,
			confirmed: false,
			controlId: "tool-confirmation",
			requireConfirm: true,
			verdict: "escalate",
		});
		return { confirmation: confirmation.pending, kind: "confirmation-required" };
	}

	return runInspectedCall(deps, {
		args: confirmation.args,
		argsSize: usageBase.argsSize,
		...(confirmed === undefined ? {} : { confirmed }),
		...(consumerKey === undefined ? {} : { consumerKey }),
		entry,
		groupId,
		requireConfirm,
		startedAt,
		...(usageBase.userId === undefined ? {} : { userId: usageBase.userId }),
	});
}

interface InspectedCallRequest {
	args: unknown;
	argsSize: number;
	confirmed?: boolean | undefined;
	consumerKey?: string | undefined;
	entry: CatalogEntry;
	groupId: string;
	requireConfirm: boolean;
	startedAt: number;
	userId?: string | undefined;
}

async function runInspectedCall(
	deps: GovernorDeps,
	call: InspectedCallRequest,
): Promise<ToolCallOutcome> {
	const forwardedArgs = await inspectArgs(
		call.entry,
		call.args,
		call.groupId,
		deps,
		call.consumerKey,
	);
	if (forwardedArgs.rejection) {
		reportUsage(deps, {
			argsSize: call.argsSize,
			...(call.confirmed === undefined ? {} : { confirmed: call.confirmed }),
			controlId: forwardedArgs.rejection.control,
			entry: call.entry,
			groupId: call.groupId,
			requireConfirm: call.requireConfirm,
			startedAt: call.startedAt,
			userId: call.userId,
			verdict: forwardedArgs.rejection.verdict,
		});
		return { kind: "refused", rejection: forwardedArgs.rejection };
	}

	const execution = await executeTool(
		call.entry,
		forwardedArgs.value,
		call.groupId,
		deps,
		call.consumerKey,
	);
	if (execution.rejection) {
		reportUsage(deps, {
			argsSize: call.argsSize,
			...(call.confirmed === undefined ? {} : { confirmed: call.confirmed }),
			controlId: execution.rejection.control,
			entry: call.entry,
			groupId: call.groupId,
			requireConfirm: call.requireConfirm,
			startedAt: call.startedAt,
			userId: call.userId,
			verdict: execution.rejection.verdict,
		});
		return { kind: "refused", rejection: execution.rejection };
	}

	return inspectResult(deps, call.entry, {
		args: call.args,
		argsSize: call.argsSize,
		confirmed: call.confirmed,
		consumerKey: call.consumerKey,
		groupId: call.groupId,
		rawResult: execution.value,
		requireConfirm: call.requireConfirm,
		startedAt: call.startedAt,
		userId: call.userId,
	});
}

function checkGrant(
	entry: CatalogEntry,
	groupId: string,
	deps: GovernorDeps,
	consumerKey?: string,
): ToolRejection | undefined {
	if (deps.grants.isGranted(groupId, entry.name)) {
		return;
	}
	const rejection: ToolRejection = {
		control: "tool-authorization",
		kind: "denied",
		verdict: "block",
	};
	deps.audit.record(
		auditEvent("interaction", {
			consumerKey: consumerKey ?? "(none)",
			controlId: rejection.control,
			detail: `tool call denied (ungranted): ${entry.name}`,
			groupId,
			seam: "mcp-tool",
			toolName: entry.name,
			verdict: "block",
		}),
	);
	return rejection;
}

interface ConfirmationCheck {
	args: unknown;
	confirmed: boolean;
	pending?: ConfirmationRequest | undefined;
}

// biome-ignore lint/complexity/useMaxParams: governance phases share (entry, args, groupId, deps, consumerKey) positionally
function checkConfirmation(
	entry: CatalogEntry,
	args: unknown,
	groupId: string,
	deps: GovernorDeps,
	consumerKey?: string,
): ConfirmationCheck {
	if (!(deps.access?.requiresConfirm(entry.name) ?? false)) {
		return { args, confirmed: false };
	}
	sweepExpiredConfirmations(deps.pending);
	const { rest, token } = takeConfirmToken(args);
	if (token !== undefined) {
		const pending = deps.pending.get(token);
		if (pending !== undefined && pending.groupId === groupId && pending.entry.name === entry.name) {
			deps.pending.delete(token);
			return { args: pending.args, confirmed: true };
		}
	}
	const request: ConfirmationRequest = { token: globalThis.crypto.randomUUID(), tool: entry.name };
	deps.pending.set(request.token, {
		args: rest,
		entry,
		expiresAt: Date.now() + CONFIRM_TTL_MS,
		groupId,
	});
	deps.audit.record(
		auditEvent("interaction", {
			consumerKey: consumerKey ?? "(none)",
			controlId: "tool-confirmation",
			detail: `tool confirmation required: ${entry.name}`,
			groupId,
			seam: "mcp-tool",
			toolName: entry.name,
			verdict: "escalate",
		}),
	);
	return { args: rest, confirmed: false, pending: request };
}

function takeConfirmToken(args: unknown): { rest: unknown; token: string | undefined } {
	if (args === null || typeof args !== "object" || Array.isArray(args)) {
		return { rest: args, token: undefined };
	}
	const record = args as Record<string, unknown>;
	const key = "confirm";
	const confirm = record[key];
	if (typeof confirm !== "string" || confirm.length === 0) {
		return { rest: args, token: undefined };
	}
	const { confirm: _dropped, ...rest } = record;
	return { rest, token: confirm };
}

function sweepExpiredConfirmations(pending: Map<string, PendingConfirmation>): void {
	const now = Date.now();
	for (const [token, request] of pending) {
		if (request.expiresAt <= now) {
			pending.delete(token);
		}
	}
}

// biome-ignore lint/complexity/useMaxParams: governance phases share (entry, args, groupId, deps, consumerKey) positionally
async function inspectArgs(
	entry: CatalogEntry,
	args: unknown,
	groupId: string,
	deps: GovernorDeps,
	consumerKey?: string,
): Promise<PhaseResult> {
	const serializedArgs = JSON.stringify(args ?? {});
	const outcome = await guardInteraction(
		{
			content: serializedArgs,
			direction: "inbound",
			groupId,
			id: nextToolInteractionId(entry.name),
			seam: "mcp-tool",
			tool: { arguments: args, name: entry.name },
		},
		deps.pipeline,
		{ audit: deps.audit, consumerKey: consumerKey ?? "(none)", jsonContent: true },
	);
	if (outcome.rejection) {
		return { rejection: toToolRejection(outcome.rejection) };
	}
	return { value: parseJsonOrEmpty(outcome.content ?? serializedArgs) };
}

// biome-ignore lint/complexity/useMaxParams: governance phases share (entry, args, groupId, deps, consumerKey) positionally
async function executeTool(
	entry: CatalogEntry,
	args: unknown,
	groupId: string,
	deps: GovernorDeps,
	consumerKey?: string,
): Promise<PhaseResult> {
	try {
		return { value: await Promise.resolve(entry.implementation(args, groupId)) };
	} catch (error) {
		const detail = describeError(error);
		const rejection: ToolRejection = {
			control: "tool-execution",
			kind: "failed",
			verdict: "block",
		};
		deps.audit.record(
			auditEvent("failure", {
				consumerKey: consumerKey ?? "(none)",
				controlId: rejection.control,
				detail,
				groupId,
				seam: "mcp-tool",
				toolName: entry.name,
				verdict: "block",
			}),
		);
		return { rejection };
	}
}

async function inspectResult(
	deps: GovernorDeps,
	entry: CatalogEntry,
	call: {
		args: unknown;
		argsSize: number;
		confirmed: boolean | undefined;
		consumerKey?: string | undefined;
		groupId: string;
		rawResult: unknown;
		requireConfirm: boolean;
		startedAt: number;
		userId: string | undefined;
	},
): Promise<ToolCallOutcome> {
	const serializedResult = serializeResult(call.rawResult);
	const outcome = await guardInteraction(
		{
			content: serializedResult,
			direction: "outbound",
			groupId: call.groupId,
			id: nextToolInteractionId(entry.name),
			seam: "mcp-tool",
			tool: { arguments: call.args, name: entry.name },
		},
		deps.pipeline,
		{ audit: deps.audit, consumerKey: call.consumerKey ?? "(none)", jsonContent: true },
	);
	if (outcome.rejection) {
		reportUsage(deps, {
			argsSize: call.argsSize,
			...(call.confirmed === undefined ? {} : { confirmed: call.confirmed }),
			controlId: outcome.rejection.control,
			entry,
			groupId: call.groupId,
			requireConfirm: call.requireConfirm,
			resultSize: serializedResult.length,
			startedAt: call.startedAt,
			userId: call.userId,
			verdict: outcome.rejection.verdict,
		});
		return { kind: "refused", rejection: toToolRejection(outcome.rejection) };
	}
	reportUsage(deps, {
		argsSize: call.argsSize,
		...(call.confirmed === undefined ? {} : { confirmed: call.confirmed }),
		entry,
		groupId: call.groupId,
		requireConfirm: call.requireConfirm,
		resultSize: (outcome.content ?? serializedResult).length,
		startedAt: call.startedAt,
		userId: call.userId,
		verdict: outcome.verdict,
	});
	return {
		kind: "executed",
		result: deserializeResult(call.rawResult, outcome.content ?? serializedResult),
		resultVerdict: outcome.verdict,
	};
}

export function toToolRejection(rejection: GuardRejection): ToolRejection {
	return {
		control: rejection.control,
		kind: rejectionKind(rejection.verdict),
		verdict: rejection.verdict,
	};
}

function userIdOf(consumerKey: string | undefined): string | undefined {
	if (consumerKey === undefined || consumerKey === "(none)") {
		return;
	}
	return consumerKey;
}

/** Byte size of the proposed args for usage estimates; never throws. */
function argsSizeOf(args: unknown): number {
	try {
		const text = JSON.stringify(args ?? {});
		return typeof text === "string" ? text.length : 2;
	} catch {
		return 2;
	}
}

function reportUsage(
	deps: GovernorDeps,
	call: {
		argsSize: number;
		confirmed?: boolean | undefined;
		controlId?: string | undefined;
		entry: CatalogEntry;
		groupId: string;
		requireConfirm?: boolean | undefined;
		resultSize?: number | undefined;
		startedAt: number;
		userId: string | undefined;
		verdict: Verdict;
	},
): void {
	const usage = deps.usage;
	if (usage === undefined) {
		return;
	}
	usage({
		...(call.confirmed === undefined ? {} : { confirmed: call.confirmed }),
		...(call.controlId === undefined ? {} : { controlId: call.controlId }),
		estimatedTokens: Math.max(
			1,
			Math.ceil((call.argsSize + (call.resultSize ?? 0)) / CHARS_PER_TOKEN_ESTIMATE),
		),
		groupId: call.groupId,
		latencyMs: Date.now() - call.startedAt,
		requireConfirm: call.requireConfirm ?? false,
		toolName: call.entry.name,
		toolSource: call.entry.source,
		...(call.userId === undefined ? {} : { userId: call.userId }),
		verdict: call.verdict,
	});
}

let toolSequence = 0;

function nextToolInteractionId(toolName: string): string {
	toolSequence += 1;
	return `tool_${toolName}_${Date.now()}_${toolSequence}`;
}

function serializeResult(result: unknown): string {
	if (typeof result === "string") {
		return result;
	}
	return JSON.stringify(result ?? null);
}

function deserializeResult(rawResult: unknown, forwarded: string): unknown {
	if (typeof rawResult === "string") {
		return forwarded;
	}
	return parseJsonOrForward(forwarded);
}
