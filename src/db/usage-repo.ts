/**
 * Durable usage repository over `usage_records`.
 *
 * Append-only by construction: this module exports inserts and windowed
 * aggregation, never updates or deletes. `costUsd` stays null for models
 * absent from the price table ("unpriced") rather than becoming a silent
 * zero — `SUM` skips nulls, so spend totals never under-report quietly while
 * token totals still cover unpriced rows. Budget enforcement aggregates here
 * instead of a separate counter table, so this is the one source of truth for
 * spend.
 */

import { and, eq, gte, type SQL, sql } from "drizzle-orm";
import type { Db } from "./index.ts";
import { usageRecords } from "./schema.ts";

/** One upstream model call that produced usage. `costUsd` null means unpriced. */
export interface UsageInsertRow {
	auditEventId?: number | undefined;
	completionTokens: number;
	costUsd?: number | undefined;
	groupId: string;
	model: string;
	promptTokens: number;
	ts?: Date | undefined;
	userId?: string | undefined;
}

export interface SpendFilter {
	groupId?: string | undefined;
	since?: Date | undefined;
	userId?: string | undefined;
}

export interface SpendSummary {
	costUsd: number;
	tokens: number;
}

/** Appends one usage row and returns its id. */
export async function insertUsage(db: Db, row: UsageInsertRow): Promise<number> {
	const created = await db
		.insert(usageRecords)
		.values({
			...(row.auditEventId === undefined ? {} : { auditEventId: row.auditEventId }),
			completionTokens: row.completionTokens,
			...(row.costUsd === undefined ? {} : { costUsd: row.costUsd }),
			groupId: row.groupId,
			model: row.model,
			promptTokens: row.promptTokens,
			...(row.ts === undefined ? {} : { ts: row.ts }),
			...(row.userId === undefined ? {} : { userId: row.userId }),
		})
		.returning({ id: usageRecords.id });
	const first = created.at(0);
	if (first === undefined) {
		throw new Error("usage insert returned no row");
	}
	return first.id;
}

/**
 * Spend and token volume over a time window (the budget-enforcement query).
 * Mirrors the `docs/storage.md` spend queries: `SUM(cost_usd)` skips unpriced
 * rows while the token total covers them. An empty window returns zeros.
 */
export async function spendInWindow(db: Db, filter: SpendFilter = {}): Promise<SpendSummary> {
	const conditions: SQL[] = [];
	if (filter.userId !== undefined) {
		conditions.push(eq(usageRecords.userId, filter.userId));
	}
	if (filter.groupId !== undefined) {
		conditions.push(eq(usageRecords.groupId, filter.groupId));
	}
	if (filter.since !== undefined) {
		conditions.push(gte(usageRecords.ts, filter.since));
	}
	const rows = await db
		.select({
			costUsd: sql<number | null>`sum(${usageRecords.costUsd})`,
			tokens: sql<
				number | null
			>`sum(${usageRecords.promptTokens} + ${usageRecords.completionTokens})`,
		})
		.from(usageRecords)
		.where(conditions.length > 0 ? and(...conditions) : undefined);
	const total = rows.at(0);
	return { costUsd: total?.costUsd ?? 0, tokens: total?.tokens ?? 0 };
}
