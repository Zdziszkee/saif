/**
 * Durable audit repository over `audit_events`.
 *
 * Append-only by construction: this module exports inserts and reads, never
 * updates or deletes. Rows are dashboard-sized (see `docs/storage.md`), not a
 * full copy of the {@link AuditEvent}: `cause`, `score`, and `policyVersion`
 * travel on the optional {@link AuditPersistenceHints} so callers on the
 * current `AuditEvent` shape keep compiling, and `promptText` is stored for
 * `block`/`escalate` verdicts only — allowed traffic is recorded without
 * content. `ts` is written from `event.timestamp` (unix seconds on disk via
 * the schema's `timestamp` mode) and every query filters `ts` through the
 * matching composite index.
 */

import { and, asc, eq, gte, lte, type SQL } from "drizzle-orm";
import type { AuditEvent } from "#/control/audit.ts";
import { isBlockingVerdict, type Verdict } from "#/control/types.ts";
import type { Db } from "./index.ts";
import { type AuditCause, auditEvents } from "./schema.ts";

/**
 * Columns that have no counterpart on today's `AuditEvent` shape. All
 * optional: plain events persist with `cause`/`score` null and the
 * `"unavailable"` policy version, and pick the real values up when callers
 * provide them.
 */
export interface AuditPersistenceHints {
	cause?: AuditCause | undefined;
	policyVersion?: string | undefined;
	promptText?: string | undefined;
	score?: number | undefined;
}

/** What {@link insertAuditEvent} accepts: a recorded event plus optional hints. */
export type AuditInsertEvent = AuditEvent & AuditPersistenceHints;

/** One persisted `audit_events` row, as read back by {@link queryAudit}. */
export type AuditRow = typeof auditEvents.$inferSelect;

export interface AuditQueryFilter {
	controlId?: string | undefined;
	groupId?: string | undefined;
	limit?: number | undefined;
	since?: Date | undefined;
	until?: Date | undefined;
	userId?: string | undefined;
	verdict?: Verdict | undefined;
}

const DEFAULT_AUDIT_LIMIT = 100;

/** Parses the event timestamp, falling back to now for unparseable values. */
function toTimestamp(timestamp: string): Date {
	const parsed = new Date(timestamp);
	return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

/**
 * Appends one audit row and returns its id (the join key for
 * `usage_records.audit_event_id`). Missing `groupId`/`policyVersion` fall
 * back to `"unknown"`/`"unavailable"` to satisfy the `NOT NULL` columns, and
 * verdict-less events persist as `"allow"`.
 */
export async function insertAuditEvent(db: Db, event: AuditInsertEvent): Promise<number> {
	const verdict = event.verdict ?? "allow";
	const created = await db
		.insert(auditEvents)
		.values({
			...(event.cause === undefined ? {} : { cause: event.cause }),
			...(event.controlId === undefined ? {} : { controlId: event.controlId }),
			groupId: event.groupId ?? "unknown",
			policyVersion: event.policyVersion ?? "unavailable",
			promptText:
				event.promptText !== undefined && isBlockingVerdict(verdict) ? event.promptText : null,
			...(event.score === undefined ? {} : { score: event.score }),
			ts: toTimestamp(event.timestamp),
			...(event.userId === undefined ? {} : { userId: event.userId }),
			verdict,
		})
		.returning({ id: auditEvents.id });
	const first = created.at(0);
	if (first === undefined) {
		throw new Error("audit insert returned no row");
	}
	return first.id;
}

/**
 * Reads audit rows newest-last (`ORDER BY ts`), filtered through the
 * index-friendly `(dimension, ts)` composites. `limit` caps the feed and
 * defaults to {@link DEFAULT_AUDIT_LIMIT}.
 */
export function queryAudit(db: Db, filter: AuditQueryFilter = {}): Promise<AuditRow[]> {
	const conditions: SQL[] = [];
	if (filter.userId !== undefined) {
		conditions.push(eq(auditEvents.userId, filter.userId));
	}
	if (filter.groupId !== undefined) {
		conditions.push(eq(auditEvents.groupId, filter.groupId));
	}
	if (filter.verdict !== undefined) {
		conditions.push(eq(auditEvents.verdict, filter.verdict));
	}
	if (filter.controlId !== undefined) {
		conditions.push(eq(auditEvents.controlId, filter.controlId));
	}
	if (filter.since !== undefined) {
		conditions.push(gte(auditEvents.ts, filter.since));
	}
	if (filter.until !== undefined) {
		conditions.push(lte(auditEvents.ts, filter.until));
	}
	return db
		.select()
		.from(auditEvents)
		.where(conditions.length > 0 ? and(...conditions) : undefined)
		.orderBy(asc(auditEvents.ts))
		.limit(filter.limit ?? DEFAULT_AUDIT_LIMIT);
}
