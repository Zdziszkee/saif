/**
 * Tool-call governance at the hub: every tool call — hub-hosted or from a
 * connected MCP server — is grant-checked, its arguments are inspected before
 * execution (redacted arguments execute redacted), and its result is inspected
 * before being returned. Blocked calls do not execute and are audited.
 */

import { type AuditSink, auditEvent, noopAuditSink } from "#/control/audit.ts";
import { type GuardRejection, guardInteraction, rejectionKind } from "#/control/guard.ts";
import type { ControlPipeline, Verdict } from "#/control/types.ts";
import { describeError } from "#/lib/errors.ts";
import { parseJsonOrEmpty, parseJsonOrForward } from "#/lib/json.ts";
import type { CatalogEntry } from "./catalog.ts";
import type { GrantRegistry } from "./grants.ts";

export interface ToolRejection {
	control: string;
	kind: "blocked" | "denied" | "escalated" | "failed";
	verdict: Verdict;
}

export type ToolCallOutcome =
	| { kind: "executed"; result: unknown; resultVerdict: Verdict }
	| { kind: "refused"; rejection: ToolRejection };

/** The defined rejection shape returned to callers in place of tool output. */
export function definedRejection(rejection: ToolRejection): string {
	return JSON.stringify({
		control: rejection.control,
		error: rejection.kind,
		verdict: rejection.verdict,
	});
}

export interface GovernorOptions {
	audit?: AuditSink | undefined;
	grants: GrantRegistry;
	pipeline: ControlPipeline;
}

export interface ToolGovernor {
	governToolCall(entry: CatalogEntry, args: unknown, groupId: string): Promise<ToolCallOutcome>;
}

interface GovernorDeps {
	audit: AuditSink;
	grants: GrantRegistry;
	pipeline: ControlPipeline;
}

type PhaseResult =
	| { rejection: ToolRejection; value?: undefined }
	| { rejection?: undefined; value: unknown };

export function createToolGovernor(options: GovernorOptions): ToolGovernor {
	const deps: GovernorDeps = {
		audit: options.audit ?? noopAuditSink,
		grants: options.grants,
		pipeline: options.pipeline,
	};
	return {
		governToolCall: (entry, args, groupId) => governToolCall(entry, args, groupId, deps),
	};
}

async function governToolCall(
	entry: CatalogEntry,
	args: unknown,
	groupId: string,
	deps: GovernorDeps,
): Promise<ToolCallOutcome> {
	const denial = checkGrant(entry, groupId, deps);
	if (denial) {
		return { kind: "refused", rejection: denial };
	}

	const forwardedArgs = await inspectArgs(entry, args, groupId, deps);
	if (forwardedArgs.rejection) {
		return { kind: "refused", rejection: forwardedArgs.rejection };
	}

	const execution = await executeTool(entry, forwardedArgs.value, groupId, deps);
	if (execution.rejection) {
		return { kind: "refused", rejection: execution.rejection };
	}

	return inspectResult(deps, entry, {
		args,
		groupId,
		rawResult: execution.value,
	});
}

function checkGrant(
	entry: CatalogEntry,
	groupId: string,
	deps: GovernorDeps,
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
			controlId: rejection.control,
			detail: `tool call denied (ungranted): ${entry.name}`,
			groupId,
			seam: "mcp-tool",
			verdict: "block",
		}),
	);
	return rejection;
}

async function inspectArgs(
	entry: CatalogEntry,
	args: unknown,
	groupId: string,
	deps: GovernorDeps,
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
		{ audit: deps.audit, jsonContent: true },
	);
	if (outcome.rejection) {
		return { rejection: toToolRejection(outcome.rejection) };
	}
	return { value: parseArgs(outcome.content ?? serializedArgs) };
}

async function executeTool(
	entry: CatalogEntry,
	args: unknown,
	groupId: string,
	deps: GovernorDeps,
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
				controlId: rejection.control,
				detail,
				groupId,
				seam: "mcp-tool",
				verdict: "block",
			}),
		);
		return { rejection };
	}
}

async function inspectResult(
	deps: GovernorDeps,
	entry: CatalogEntry,
	call: { args: unknown; rawResult: unknown; groupId: string },
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
		{ audit: deps.audit, jsonContent: true },
	);
	if (outcome.rejection) {
		return { kind: "refused", rejection: toToolRejection(outcome.rejection) };
	}
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

let toolSequence = 0;

function nextToolInteractionId(toolName: string): string {
	toolSequence += 1;
	return `tool_${toolName}_${Date.now()}_${toolSequence}`;
}

function parseArgs(serialized: string): unknown {
	return parseJsonOrEmpty(serialized);
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
