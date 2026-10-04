/**
 * MCP tool-usage logging and aggregation.
 *
 * Every terminal tool-call outcome (executed, refused, confirmation-required)
 * is reported here by governance through a plain callback — this module never
 * touches the hub, so there is no import cycle. Durable rows land in the
 * additive `mcp_tool_calls` table (existing tables are untouched); the pure
 * {@link summarizeToolUsage} derives the same dashboard stats from the
 * in-memory audit sink for surfaces that never open the database.
 */

import { and, asc, count, eq, gte, type SQL } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { AuditEvent } from "#/control/audit.ts";
import type { Verdict } from "#/control/types.ts";
import { type auditEvents, mcpToolCalls, type usageRecords } from "#/db/schema.ts";
import type { ToolSource } from "./catalog.ts";

/** Database handle shape matching `db` in `src/db/index.ts`. */
export type ToolDb = BunSQLiteDatabase<{
	auditEvents: typeof auditEvents;
	mcpToolCalls: typeof mcpToolCalls;
	usageRecords: typeof usageRecords;
}>;

/** One terminal tool-call outcome, as reported by governance. */
export interface ToolUsageRecord {
	/** Confirmation outcome; undefined when the tool needs no confirmation. */
	confirmed?: boolean | undefined;
	/** Decisive control for non-allow verdicts (`tool-authorization`, …). */
	controlId?: string | undefined;
	/** chars/4 heuristic over inspected args + result; estimate, never billed. */
	estimatedTokens: number;
	groupId: string;
	latencyMs: number;
	requireConfirm: boolean;
	toolName: string;
	toolSource: ToolSource;
	userId?: string | undefined;
	verdict: Verdict;
}

/** A persisted row: the record plus the policy version in force. */
export type ToolUsageRow = ToolUsageRecord & { policyVersion: string };

/** Append-only insert of one tool-call row. */
export async function recordToolCall(db: ToolDb, row: ToolUsageRow): Promise<void> {
	await db.insert(mcpToolCalls).values({
		...(row.confirmed === undefined ? {} : { confirmed: row.confirmed ? 1 : 0 }),
		...(row.controlId === undefined ? {} : { controlId: row.controlId }),
		estimatedTokens: row.estimatedTokens,
		groupId: row.groupId,
		latencyMs: row.latencyMs,
		policyVersion: row.policyVersion,
		requireConfirm: row.requireConfirm ? 1 : 0,
		toolName: row.toolName,
		toolSource: row.toolSource,
		...(row.userId === undefined ? {} : { userId: row.userId }),
		verdict: row.verdict,
	});
}

export interface ToolCallCounts {
	calls: number;
	toolName: string;
	verdict: Verdict;
}

export interface ToolCallStatsFilter {
	groupId?: string | undefined;
	since?: Date | undefined;
	toolName?: string | undefined;
}

/** One persisted MCP tool call for cost/token aggregation. */
export interface ToolCallRecord {
	/** chars/4 heuristic over inspected args + result; estimate, never billed. */
	estimatedTokens: number;
	toolName: string;
	/** Timestamp-mode column: drizzle returns a Date; kept wide for callers. */
	ts: Date | number;
	userId: string | null;
	verdict: Verdict;
}

export interface ListToolUsageOptions {
	limit?: number | undefined;
	since?: Date | undefined;
}

const DEFAULT_LIST_LIMIT = 5000;

/**
 * Tool-call rows oldest-first (ascending by ts), capped at `limit`.
 * Never filters by verdict — every terminal outcome counts as metered MCP
 * activity for the cost/token plot.
 */
export async function listToolUsage(
	db: ToolDb,
	options: ListToolUsageOptions = {},
): Promise<ToolCallRecord[]> {
	const limit = options.limit ?? DEFAULT_LIST_LIMIT;
	const rows = await db
		.select({
			estimatedTokens: mcpToolCalls.estimatedTokens,
			toolName: mcpToolCalls.toolName,
			ts: mcpToolCalls.ts,
			userId: mcpToolCalls.userId,
			verdict: mcpToolCalls.verdict,
		})
		.from(mcpToolCalls)
		.where(options.since === undefined ? undefined : gte(mcpToolCalls.ts, options.since))
		.orderBy(asc(mcpToolCalls.ts))
		.limit(limit);
	return rows.map((row) => ({
		estimatedTokens: row.estimatedTokens,
		toolName: row.toolName,
		ts: row.ts,
		userId: row.userId,
		verdict: row.verdict,
	}));
}

/** Calls per tool per verdict, for dashboard aggregation. */
export async function toolCallCounts(
	db: ToolDb,
	filter: ToolCallStatsFilter = {},
): Promise<ToolCallCounts[]> {
	const conditions: SQL[] = [];
	if (filter.groupId !== undefined) {
		conditions.push(eq(mcpToolCalls.groupId, filter.groupId));
	}
	if (filter.toolName !== undefined) {
		conditions.push(eq(mcpToolCalls.toolName, filter.toolName));
	}
	if (filter.since !== undefined) {
		conditions.push(gte(mcpToolCalls.ts, filter.since));
	}
	const rows = await db
		.select({
			calls: count(),
			toolName: mcpToolCalls.toolName,
			verdict: mcpToolCalls.verdict,
		})
		.from(mcpToolCalls)
		.where(conditions.length > 0 ? and(...conditions) : undefined)
		.groupBy(mcpToolCalls.toolName, mcpToolCalls.verdict);
	return rows.map((row) => ({ calls: row.calls, toolName: row.toolName, verdict: row.verdict }));
}

export interface ToolUsageSummary {
	byGroup: [string, number][];
	byTool: [string, number][];
	byVerdict: [string, number][];
	confirmationsRequested: number;
	total: number;
}

/** Detail suffixes that carry a tool name (`…: <tool>`). */
const TOOL_DETAIL = /(?:ungranted|required): (\S+)$|^unknown tool: (\S+)$/;

function toolOf(event: AuditEvent): string {
	if (event.toolName !== undefined) {
		return event.toolName;
	}
	const match = event.detail === undefined ? null : TOOL_DETAIL.exec(event.detail);
	return match?.[1] ?? match?.[2] ?? "unknown";
}

/**
 * Dashboard shaping over the audit sink: per-tool, per-group, and per-verdict
 * counts over `mcp-tool` decisions plus the number of confirmation requests.
 * Newest-agnostic — callers slice `recent` themselves if needed.
 */
export function summarizeToolUsage(events: readonly AuditEvent[]): ToolUsageSummary {
	const decisions = events.filter(
		(event) =>
			event.kind === "interaction" && event.seam === "mcp-tool" && event.verdict !== undefined,
	);
	const byCount = (key: (event: AuditEvent) => string): [string, number][] => {
		const counts = new Map<string, number>();
		for (const event of decisions) {
			const label = key(event);
			counts.set(label, (counts.get(label) ?? 0) + 1);
		}
		return [...counts.entries()].sort((left, right) => right[1] - left[1]);
	};
	return {
		byGroup: byCount((event) => event.groupId ?? "unknown"),
		byTool: byCount(toolOf),
		byVerdict: byCount((event) => event.verdict ?? "none"),
		confirmationsRequested: decisions.filter((event) => event.controlId === "tool-confirmation")
			.length,
		total: decisions.length,
	};
}
