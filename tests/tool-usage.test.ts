/**
 * MCP tool-usage coverage: `recordToolCall` / `toolCallCounts` persistence and
 * the pure `summarizeToolUsage` shaping over audit events.
 *
 * Hermetic: every test builds its own `:memory:` SQLite database. The DDL
 * below mirrors `drizzle/0001_add-mcp-tool-calls.sql` exactly (the
 * `--> statement-breakpoint` markers are `--` line comments to SQLite) so no
 * migrate step is needed.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { auditEvent } from "#/control/audit.ts";
import { auditEvents, mcpToolCalls, usageRecords } from "#/db/schema.ts";
import {
	recordToolCall,
	summarizeToolUsage,
	type ToolDb,
	type ToolUsageRow,
	toolCallCounts,
} from "#/hub/tool-usage.ts";

// Mirror of drizzle/0001_add-mcp-tool-calls.sql — kept inline for hermetic tests.
const MCP_TOOL_CALLS_DDL = `CREATE TABLE \`mcp_tool_calls\` (
	\`confirmed\` integer,
	\`control_id\` text,
	\`estimated_tokens\` integer NOT NULL,
	\`user_group_id\` text NOT NULL,
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`latency_ms\` integer,
	\`policy_version\` text NOT NULL,
	\`require_confirm\` integer DEFAULT 0 NOT NULL,
	\`tool_name\` text NOT NULL,
	\`tool_source\` text NOT NULL,
	\`ts\` integer DEFAULT (unixepoch()) NOT NULL,
	\`user_id\` text,
	\`verdict\` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX \`mcp_tool_calls_ts_idx\` ON \`mcp_tool_calls\` (\`ts\`);--> statement-breakpoint
CREATE INDEX \`mcp_tool_calls_tool_ts_idx\` ON \`mcp_tool_calls\` (\`tool_name\`,\`ts\`);--> statement-breakpoint
CREATE INDEX \`mcp_tool_calls_user_ts_idx\` ON \`mcp_tool_calls\` (\`user_id\`,\`ts\`);--> statement-breakpoint
CREATE INDEX \`mcp_tool_calls_group_ts_idx\` ON \`mcp_tool_calls\` (\`user_group_id\`,\`ts\`);--> statement-breakpoint
CREATE INDEX \`mcp_tool_calls_verdict_ts_idx\` ON \`mcp_tool_calls\` (\`verdict\`,\`ts\`);`;

function createDb(): { db: ToolDb; sqlite: Database } {
	const sqlite = new Database(":memory:");
	sqlite.exec(MCP_TOOL_CALLS_DDL);
	const db = drizzle(sqlite, { schema: { auditEvents, mcpToolCalls, usageRecords } });
	return { db, sqlite };
}

function countKey(row: { calls: number; toolName: string; verdict: string }): string {
	return `${row.calls}|${row.toolName}|${row.verdict}`;
}

function sortedKeys(
	rows: readonly { calls: number; toolName: string; verdict: string }[],
): string[] {
	return rows.map(countKey).sort((left, right) => left.localeCompare(right));
}

describe("recordToolCall and toolCallCounts", () => {
	it("roundtrips rows and groups calls per tool per verdict", async () => {
		const { db } = createDb();
		const rows: ToolUsageRow[] = [
			{
				estimatedTokens: 40,
				groupId: "eng",
				latencyMs: 12,
				policyVersion: "v1",
				requireConfirm: false,
				toolName: "search",
				toolSource: "builtin",
				userId: "alice",
				verdict: "allow",
			},
			{
				estimatedTokens: 20,
				groupId: "eng",
				latencyMs: 8,
				policyVersion: "v1",
				requireConfirm: false,
				toolName: "search",
				toolSource: "builtin",
				verdict: "allow",
			},
			{
				controlId: "tool-authorization",
				estimatedTokens: 30,
				groupId: "eng",
				latencyMs: 15,
				policyVersion: "v1",
				requireConfirm: false,
				toolName: "search",
				toolSource: "connected",
				userId: "bob",
				verdict: "block",
			},
			{
				confirmed: false,
				controlId: "tool-confirmation",
				estimatedTokens: 50,
				groupId: "eng",
				latencyMs: 25,
				policyVersion: "v1",
				requireConfirm: true,
				toolName: "delete-file",
				toolSource: "connected",
				userId: "alice",
				verdict: "escalate",
			},
			{
				estimatedTokens: 10,
				groupId: "ops",
				latencyMs: 5,
				policyVersion: "v1",
				requireConfirm: false,
				toolName: "delete-file",
				toolSource: "builtin",
				userId: "carol",
				verdict: "allow",
			},
		];
		for (const row of rows) {
			// biome-ignore lint/performance/noAwaitInLoops: seed rows in order
			await recordToolCall(db, row);
		}
		expect(sortedKeys(await toolCallCounts(db))).toEqual([
			"1|delete-file|allow",
			"1|delete-file|escalate",
			"1|search|block",
			"2|search|allow",
		]);
	});

	it("filters by groupId", async () => {
		const { db } = createDb();
		await recordToolCall(db, {
			estimatedTokens: 10,
			groupId: "eng",
			latencyMs: 3,
			policyVersion: "v1",
			requireConfirm: false,
			toolName: "search",
			toolSource: "builtin",
			verdict: "allow",
		});
		await recordToolCall(db, {
			estimatedTokens: 10,
			groupId: "ops",
			latencyMs: 3,
			policyVersion: "v1",
			requireConfirm: false,
			toolName: "search",
			toolSource: "builtin",
			verdict: "allow",
		});
		await recordToolCall(db, {
			controlId: "tool-authorization",
			estimatedTokens: 10,
			groupId: "eng",
			latencyMs: 3,
			policyVersion: "v1",
			requireConfirm: false,
			toolName: "search",
			toolSource: "builtin",
			verdict: "block",
		});
		expect(sortedKeys(await toolCallCounts(db, { groupId: "eng" }))).toEqual([
			"1|search|allow",
			"1|search|block",
		]);
	});

	it("filters by toolName", async () => {
		const { db } = createDb();
		await recordToolCall(db, {
			estimatedTokens: 10,
			groupId: "eng",
			latencyMs: 3,
			policyVersion: "v1",
			requireConfirm: false,
			toolName: "search",
			toolSource: "builtin",
			verdict: "allow",
		});
		await recordToolCall(db, {
			estimatedTokens: 10,
			groupId: "eng",
			latencyMs: 3,
			policyVersion: "v1",
			requireConfirm: false,
			toolName: "delete-file",
			toolSource: "builtin",
			verdict: "allow",
		});
		expect(sortedKeys(await toolCallCounts(db, { toolName: "search" }))).toEqual([
			"1|search|allow",
		]);
	});

	it("filters by since, excluding older rows", async () => {
		const { db } = createDb();
		await db.insert(mcpToolCalls).values({
			estimatedTokens: 10,
			groupId: "eng",
			latencyMs: 3,
			policyVersion: "v1",
			requireConfirm: 0,
			toolName: "stale-tool",
			toolSource: "builtin",
			ts: new Date(Date.now() - 86_400_000),
			verdict: "allow",
		});
		await recordToolCall(db, {
			estimatedTokens: 12,
			groupId: "eng",
			latencyMs: 4,
			policyVersion: "v1",
			requireConfirm: false,
			toolName: "search",
			toolSource: "builtin",
			verdict: "allow",
		});
		const recent = await toolCallCounts(db, { since: new Date(Date.now() - 3_600_000) });
		expect(recent).toEqual([{ calls: 1, toolName: "search", verdict: "allow" }]);
		expect((await toolCallCounts(db)).length).toBe(2);
	});

	it("returns no rows when nothing matches the filter", async () => {
		const { db } = createDb();
		await recordToolCall(db, {
			estimatedTokens: 10,
			groupId: "eng",
			latencyMs: 3,
			policyVersion: "v1",
			requireConfirm: false,
			toolName: "search",
			toolSource: "builtin",
			verdict: "allow",
		});
		expect(await toolCallCounts(db, { groupId: "no-such-group" })).toEqual([]);
		expect(await toolCallCounts(db, { toolName: "no-such-tool" })).toEqual([]);
	});
});

describe("tool-call boolean and user mapping", () => {
	it("stores requireConfirm as 1/0, confirmed as 1/0/NULL, and userId as-is", async () => {
		const { db, sqlite } = createDb();
		await recordToolCall(db, {
			confirmed: false,
			controlId: "tool-confirmation",
			estimatedTokens: 50,
			groupId: "eng",
			latencyMs: 25,
			policyVersion: "v1",
			requireConfirm: true,
			toolName: "delete-file",
			toolSource: "connected",
			userId: "alice",
			verdict: "escalate",
		});
		await recordToolCall(db, {
			estimatedTokens: 40,
			groupId: "eng",
			latencyMs: 12,
			policyVersion: "v1",
			requireConfirm: false,
			toolName: "search",
			toolSource: "builtin",
			verdict: "allow",
		});
		await recordToolCall(db, {
			confirmed: true,
			controlId: "tool-confirmation",
			estimatedTokens: 44,
			groupId: "eng",
			latencyMs: 30,
			policyVersion: "v1",
			requireConfirm: true,
			toolName: "delete-file",
			toolSource: "connected",
			userId: "bob",
			verdict: "allow",
		});
		const raw = sqlite
			.query(
				"SELECT confirmed, require_confirm AS requireConfirm, user_id AS userId FROM mcp_tool_calls ORDER BY id ASC",
			)
			.all() as { confirmed: number | null; requireConfirm: number; userId: string | null }[];
		expect(raw).toEqual([
			{ confirmed: 0, requireConfirm: 1, userId: "alice" },
			{ confirmed: null, requireConfirm: 0, userId: null },
			{ confirmed: 1, requireConfirm: 1, userId: "bob" },
		]);
	});
});

describe("summarizeToolUsage", () => {
	it("counts byTool from the toolName field", () => {
		const summary = summarizeToolUsage([
			auditEvent("interaction", {
				groupId: "eng",
				seam: "mcp-tool",
				toolName: "search",
				verdict: "allow",
			}),
			auditEvent("interaction", {
				groupId: "eng",
				seam: "mcp-tool",
				toolName: "search",
				verdict: "allow",
			}),
			auditEvent("interaction", {
				controlId: "tool-confirmation",
				groupId: "eng",
				seam: "mcp-tool",
				toolName: "delete-file",
				verdict: "escalate",
			}),
		]);
		expect(summary.total).toBe(3);
		expect(summary.byTool).toEqual([
			["search", 2],
			["delete-file", 1],
		]);
	});

	it("falls back to parsing detail when toolName is absent", () => {
		const summary = summarizeToolUsage([
			auditEvent("interaction", {
				detail: "unknown tool: mystery",
				groupId: "ops",
				seam: "mcp-tool",
				verdict: "block",
			}),
			auditEvent("interaction", {
				detail: "tool confirmation required: writer",
				groupId: "ops",
				seam: "mcp-tool",
				verdict: "escalate",
			}),
			// Governance emits the parenthesized form `tool call denied (ungranted): NAME`,
			// which the TOOL_DETAIL pattern (`ungranted: NAME`) does not match, so it
			// currently aggregates under "unknown" rather than the tool name.
			auditEvent("interaction", {
				detail: "tool call denied (ungranted): frob",
				groupId: "ops",
				seam: "mcp-tool",
				verdict: "block",
			}),
		]);
		expect(Object.fromEntries(summary.byTool)).toEqual({
			mystery: 1,
			unknown: 1,
			writer: 1,
		});
	});

	it("counts byGroup, byVerdict, confirmationsRequested, and total", () => {
		const summary = summarizeToolUsage([
			auditEvent("interaction", {
				groupId: "eng",
				seam: "mcp-tool",
				toolName: "search",
				verdict: "allow",
			}),
			auditEvent("interaction", {
				controlId: "tool-confirmation",
				groupId: "eng",
				seam: "mcp-tool",
				toolName: "delete-file",
				verdict: "escalate",
			}),
			auditEvent("interaction", {
				controlId: "tool-confirmation",
				groupId: "ops",
				seam: "mcp-tool",
				toolName: "writer",
				verdict: "escalate",
			}),
			auditEvent("interaction", {
				controlId: "tool-authorization",
				groupId: "ops",
				seam: "mcp-tool",
				toolName: "search",
				verdict: "block",
			}),
		]);
		expect(summary.total).toBe(4);
		expect(summary.confirmationsRequested).toBe(2);
		expect(summary.byGroup).toEqual([
			["eng", 2],
			["ops", 2],
		]);
		expect(summary.byVerdict).toEqual([
			["escalate", 2],
			["allow", 1],
			["block", 1],
		]);
	});

	it("excludes non-mcp-tool seams, non-interaction kinds, and verdict-less events", () => {
		const summary = summarizeToolUsage([
			auditEvent("interaction", {
				groupId: "eng",
				seam: "chat",
				toolName: "search",
				verdict: "allow",
			}),
			auditEvent("interaction", {
				groupId: "eng",
				seam: "mcp-tool",
				toolName: "search",
			}),
			auditEvent("registration", {
				groupId: "eng",
				seam: "mcp-tool",
				toolName: "search",
				verdict: "allow",
			}),
			auditEvent("interaction", {
				groupId: "eng",
				seam: "mcp-tool",
				toolName: "search",
				verdict: "allow",
			}),
		]);
		expect(summary.total).toBe(1);
		expect(summary.byTool).toEqual([["search", 1]]);
	});

	it("returns zeros for empty input without crashing", () => {
		expect(summarizeToolUsage([])).toEqual({
			byGroup: [],
			byTool: [],
			byVerdict: [],
			confirmationsRequested: 0,
			total: 0,
		});
	});
});
