/**
 * Durable drizzle-backed implementation of the `GatewayStore` contract in
 * `#/gateway/store.ts`.
 *
 * Append-only: this module exposes inserts and reads only, never
 * update/delete. Production code wires the singleton `db` from
 * `#/db/index.ts`; tests inject their own in-memory drizzle instance via
 * `createGatewayStore`, so this module never imports the production `db`
 * value (type-only import, erased at runtime).
 */

import { and, asc, eq, gt, gte } from "drizzle-orm";

import type { db } from "#/db/index.ts";
import { auditEvents, usageRecords } from "#/db/schema.ts";
import type {
	GatewayAuditRow,
	GatewayStore,
	GatewayUsageRow,
	SpendSummary,
} from "#/gateway/store.ts";

type AppDatabase = typeof db;

/** `SpendSummary` plus tokens from rows with no price (`costUsd: null`). */
export interface DetailedSpendSummary extends SpendSummary {
	unpricedTokens: number;
}

/** The store contract plus the unpriced-aware spend detail. */
export interface GatewayStoreWithSpendDetail extends GatewayStore {
	spendSinceDetailed(userId: string, since: number): Promise<DetailedSpendSummary>;
}

const FIRST_ROW_INDEX = 0;
const MS_PER_SECOND = 1000;
const MIN_CURSOR = 0;

function toUnixSeconds(value: Date): number {
	return Math.floor(value.getTime() / MS_PER_SECOND);
}

function sinceDate(sinceUnixSec: number): Date {
	return new Date(Math.max(MIN_CURSOR, Math.floor(sinceUnixSec)) * MS_PER_SECOND);
}

function normalizeCursor(cursor: number): number {
	if (!Number.isFinite(cursor)) {
		return MIN_CURSOR;
	}
	return Math.max(MIN_CURSOR, Math.floor(cursor));
}

function normalizeLimit(limit: number): number {
	if (!Number.isFinite(limit)) {
		return MIN_CURSOR;
	}
	return Math.max(MIN_CURSOR, Math.floor(limit));
}

async function recordAuditRow(database: AppDatabase, row: GatewayAuditRow): Promise<number> {
	const inserted = await database
		.insert(auditEvents)
		.values({
			cause: row.cause,
			controlId: row.controlId,
			groupId: row.groupId,
			model: row.model,
			policyVersion: row.policyVersion,
			promptText: row.promptText,
			score: row.score,
			userId: row.userId,
			verdict: row.verdict,
		})
		.returning({ id: auditEvents.id });
	const first = inserted[FIRST_ROW_INDEX];
	if (first === undefined) {
		throw new Error("audit insert returned no rows");
	}
	return first.id;
}

async function recordUsageRow(database: AppDatabase, row: GatewayUsageRow): Promise<number> {
	const inserted = await database
		.insert(usageRecords)
		.values({
			auditEventId: row.auditEventId,
			completionTokens: row.completionTokens,
			costUsd: row.costUsd,
			groupId: row.groupId,
			model: row.model,
			promptTokens: row.promptTokens,
			userId: row.userId,
		})
		.returning({ id: usageRecords.id });
	const first = inserted[FIRST_ROW_INDEX];
	if (first === undefined) {
		throw new Error("usage insert returned no rows");
	}
	return first.id;
}

async function spendSinceDetailed(
	database: AppDatabase,
	userId: string,
	since: number,
): Promise<DetailedSpendSummary> {
	const rows = await database
		.select({
			completionTokens: usageRecords.completionTokens,
			costUsd: usageRecords.costUsd,
			promptTokens: usageRecords.promptTokens,
		})
		.from(usageRecords)
		.where(and(eq(usageRecords.userId, userId), gte(usageRecords.ts, sinceDate(since))));
	let costUsd = 0;
	let tokens = 0;
	let unpricedTokens = 0;
	for (const row of rows) {
		const rowTokens = row.promptTokens + row.completionTokens;
		tokens += rowTokens;
		if (row.costUsd === null) {
			unpricedTokens += rowTokens;
		} else {
			costUsd += row.costUsd;
		}
	}
	return { costUsd, tokens, unpricedTokens };
}

async function pollStore(
	database: AppDatabase,
	cursor: number,
	limit: number,
): Promise<{
	events: Array<GatewayAuditRow & { id: number; ts: number }>;
	usage: Array<GatewayUsageRow & { id: number; ts: number }>;
}> {
	const take = normalizeLimit(limit);
	const from = normalizeCursor(cursor);
	const [eventRows, usageRows] = await Promise.all([
		database
			.select()
			.from(auditEvents)
			.where(gt(auditEvents.id, from))
			.orderBy(asc(auditEvents.id))
			.limit(take),
		database
			.select()
			.from(usageRecords)
			.where(gt(usageRecords.id, from))
			.orderBy(asc(usageRecords.id))
			.limit(take),
	]);
	return {
		events: eventRows.map((row) => ({
			cause: row.cause,
			controlId: row.controlId,
			groupId: row.groupId,
			id: row.id,
			model: row.model,
			policyVersion: row.policyVersion,
			promptText: row.promptText,
			score: row.score,
			ts: toUnixSeconds(row.ts),
			userId: row.userId,
			verdict: row.verdict,
		})),
		usage: usageRows.map((row) => ({
			auditEventId: row.auditEventId,
			completionTokens: row.completionTokens,
			costUsd: row.costUsd,
			groupId: row.groupId,
			id: row.id,
			model: row.model,
			promptTokens: row.promptTokens,
			ts: toUnixSeconds(row.ts),
			userId: row.userId,
		})),
	};
}

/**
 * Build the durable store over any drizzle instance sharing the schema in
 * `#/db/schema.ts`. Pass the production `db` in routes, an in-memory
 * instance in tests.
 */
export function createGatewayStore(database: AppDatabase): GatewayStoreWithSpendDetail {
	return {
		poll: (cursor, limit) => pollStore(database, cursor, limit),
		recordAudit: (row) => recordAuditRow(database, row),
		recordUsage: (row) => recordUsageRow(database, row),
		spendSince: async (userId, since) => spendSinceDetailed(database, userId, since),
		spendSinceDetailed: (userId, since) => spendSinceDetailed(database, userId, since),
	};
}
