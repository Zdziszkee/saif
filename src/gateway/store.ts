import type { AuditCause, Verdict } from "#/db/schema.ts";

/**
 * Storage contract for the LLM gateway seam, shared by the route and the
 * sqlite implementation. The route depends only on this interface; tests
 * inject fakes, production wires the drizzle-backed store.
 *
 * Field meanings mirror `src/db/schema.ts`, which stays the single
 * definition of the tables.
 */
export interface GatewayAuditRow {
	cause: AuditCause | null;
	controlId: string | null;
	groupId: string;
	/** Requested model; null when unknown (identity/shape rejections). */
	model: string | null;
	policyVersion: string;
	/** Exact prompt; populated only for `block`/`escalate`. */
	promptText: string | null;
	score: number | null;
	/** Null only at group-scoped surfaces that identify no individual. */
	userId: string | null;
	verdict: Verdict;
}

export interface GatewayUsageRow {
	auditEventId: number | null;
	completionTokens: number;
	costUsd: number | null;
	groupId: string;
	model: string;
	promptTokens: number;
	/** Null only at group-scoped surfaces that identify no individual. */
	userId: string | null;
}

export interface SpendSummary {
	costUsd: number;
	tokens: number;
	/** Tokens from calls whose model had no known price. */
	unpricedTokens: number;
}

export interface GatewayStore {
	/**
	 * Rows with `id` greater than `cursor`, for UI polling. Both lists are
	 * ordered ascending and capped at `limit` entries each.
	 */
	poll(
		cursor: number,
		limit: number,
	): Promise<{
		events: Array<GatewayAuditRow & { id: number; ts: number }>;
		usage: Array<GatewayUsageRow & { id: number; ts: number }>;
	}>;
	/** Append one audit row; returns its id. Never updates. */
	recordAudit(row: GatewayAuditRow): number | Promise<number>;
	/** Append one usage row; returns its id. Never updates. */
	recordUsage(row: GatewayUsageRow): number | Promise<number>;
	/** Spend for a user at or after `since` (unix seconds). */
	spendSince(userId: string, since: number): SpendSummary | Promise<SpendSummary>;
}
