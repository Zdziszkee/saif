import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Storage schema for the LLM gateway seam.
 *
 * Three tables, sized for dashboard queries rather than for completeness:
 *
 *  - `audit_events`  — what happened to an interaction (who, when, verdict, why)
 *  - `usage_records` — what the upstream model cost (tokens and computed cost)
 *  - `mcp_tool_calls` — which MCP tool ran for whom (tool, verdict, confirmation)
 *
 * Deliberately NOT stored: latency, per-hit detail rows, raw upstream status,
 * or a separate budget table. Budget limits are enforced by aggregating
 * `usage_records` over a time window, so there is one source of truth for spend.
 */

/** Verdict applied to an interaction. Mirrors `Verdict` in `src/control/types.ts`. */
export const VERDICTS = ["allow", "block", "escalate", "redact"] as const;

/**
 * Why an interaction did not proceed normally. `null` means it was allowed
 * through. Every rejection maps to one of these so the dashboard can group
 * "why are we blocking things?" without parsing free text.
 */
export const AUDIT_CAUSES = [
	/** Required identity headers (`x-user-id` / `x-user-group-id`) were absent. */
	"missing-identity",
	/** `x-user-group-id` named a group the configuration does not define. */
	"unknown-group",
	/** The user's token/cost budget for the current window is spent. */
	"budget-exhausted",
	/** A deterministic, signature or Jev check rejected the content. */
	"blocked-by-check",
	/** The semantic tier timed out or errored; the failure verdict was applied. */
	"classifier-failure",
	/** The upstream provider failed after the prompt had passed validation. */
	"upstream-failure",
	/** The request body did not match the chat-completions schema. */
	"malformed-request",
] as const;

export type Verdict = (typeof VERDICTS)[number];
export type AuditCause = (typeof AUDIT_CAUSES)[number];

/**
 * One row per governed interaction.
 *
 * `prompt_text` is populated only for `block` / `escalate` outcomes: that is the
 * attack evidence a security team needs. Allowed traffic is recorded without
 * content.
 */
export const auditEvents = sqliteTable(
	"audit_events",
	{
		/** Null when the interaction was allowed through. */
		cause: text({ enum: AUDIT_CAUSES }),
		/** The decisive check id, e.g. `prompt_injection` or a detection rule id. */
		controlId: text("control_id"),
		/** Full scored evidence, e.g. `prompt_injection=0.91, jailbreak=0.87`. */
		detail: text("detail"),
		/** Policy subject group; drives check selection and group-level reporting. */
		groupId: text("user_group_id").notNull(),
		id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
		/** Requested model; null on rejections that never parsed a body. */
		model: text(),
		/** Hash of the policy document in force, so edits can be correlated with outcomes. */
		policyVersion: text("policy_version").notNull(),
		/** Exact prompt, `block`/`escalate` only. Null for allowed traffic. */
		promptText: text("prompt_text"),
		/**
		 * How confident the decisive check was: a Jev probability P(true), or a
		 * detection confidence. Null when the cause was not a check (budget,
		 * identity) or the check reports no score.
		 */
		score: real("score"),
		/** Event time (unix seconds). */
		ts: integer("ts", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
		/**
		 * The individual caller, from `x-user-id`. Null only at group-scoped
		 * surfaces that identify no individual (MCP hub tool calls).
		 */
		userId: text("user_id"),
		verdict: text("verdict", { enum: VERDICTS }).notNull(),
	},
	(table) => [
		index("audit_events_ts_idx").on(table.ts),
		index("audit_events_user_ts_idx").on(table.userId, table.ts),
		index("audit_events_group_ts_idx").on(table.groupId, table.ts),
		index("audit_events_verdict_ts_idx").on(table.verdict, table.ts),
	],
);

/**
 * One row per upstream model call that produced usage.
 *
 * `costUsd` is null when the model is absent from the cached price table. That
 * is a real, visible state ("unpriced") rather than a silent zero — the
 * dashboard should surface it so cost totals are not quietly under-reported.
 */
export const usageRecords = sqliteTable(
	"usage_records",
	{
		/** Null when the call never produced a governed interaction (e.g. pre-flight). */
		auditEventId: integer("audit_event_id").references(() => auditEvents.id, {
			onDelete: "set null",
		}),
		completionTokens: integer("completion_tokens").notNull(),
		/** USD, from the cached LiteLLM price table. Null = model not priced. */
		costUsd: real("cost_usd"),
		groupId: text("user_group_id").notNull(),
		id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
		model: text().notNull(),
		promptTokens: integer("prompt_tokens").notNull(),
		ts: integer("ts", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
		/** Null only at group-scoped surfaces that identify no individual. */
		userId: text("user_id"),
	},
	(table) => [
		index("usage_records_ts_idx").on(table.ts),
		index("usage_records_user_ts_idx").on(table.userId, table.ts),
		index("usage_records_group_ts_idx").on(table.groupId, table.ts),
		index("usage_records_audit_event_idx").on(table.auditEventId),
	],
);

/** Where an MCP tool call executed from. Mirrors `ToolSource` in `src/hub/catalog.ts`. */
export const TOOL_SOURCES = ["builtin", "connected"] as const;

/**
 * One row per terminal MCP tool-call outcome.
 *
 * Additive: existing tables are untouched. `confirmed` is null when the tool
 * needs no confirmation; `estimatedTokens` is a chars/4 heuristic over the
 * inspected args + result (estimate, never billed — model cost stays in
 * `usage_records`). Tool arguments and results are never stored.
 */
export const mcpToolCalls = sqliteTable(
	"mcp_tool_calls",
	{
		/** Confirmation outcome (1/0); null when the tool needs no confirmation. */
		confirmed: integer("confirmed"),
		/** Decisive control for non-allow verdicts (`tool-authorization`, …). */
		controlId: text("control_id"),
		estimatedTokens: integer("estimated_tokens").notNull(),
		/** Policy subject group; drives tool access and group-level reporting. */
		groupId: text("user_group_id").notNull(),
		id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
		latencyMs: integer("latency_ms"),
		/** Hash of the tool-policy document in force, for correlating edits with outcomes. */
		policyVersion: text("policy_version").notNull(),
		requireConfirm: integer("require_confirm").notNull().default(0),
		toolName: text("tool_name").notNull(),
		toolSource: text("tool_source", { enum: TOOL_SOURCES }).notNull(),
		/** Event time (unix seconds). */
		ts: integer("ts", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
		/** The individual caller, from `x-user-id`. Null at group-scoped surfaces. */
		userId: text("user_id"),
		verdict: text("verdict", { enum: VERDICTS }).notNull(),
	},
	(table) => [
		index("mcp_tool_calls_ts_idx").on(table.ts),
		index("mcp_tool_calls_tool_ts_idx").on(table.toolName, table.ts),
		index("mcp_tool_calls_user_ts_idx").on(table.userId, table.ts),
		index("mcp_tool_calls_group_ts_idx").on(table.groupId, table.ts),
		index("mcp_tool_calls_verdict_ts_idx").on(table.verdict, table.ts),
	],
);
