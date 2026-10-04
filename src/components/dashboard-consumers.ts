/**
 * Per-consumer shaping for the security dashboard.
 *
 * Audit-layer utilities over raw `AuditEvent[]`. The dashboard route does NOT
 * use this module: it renders master's shaped `DashboardData`
 * (`src/dashboard/data.ts` `byConsumer` record + `selectMetrics`, fed by
 * `getDashboardData` in `src/dashboard/server.ts`). Everything here stays
 * because its key semantics differ from master's and are pinned by
 * `tests/dashboard-per-consumer.test.ts`:
 * - `consumerKeyOf` prefers the dedicated `consumerKey` (the raw presented
 *   key), falls back to the policy subject `groupId` (the user group that
 *   selects the profile and the applicable checks, see
 *   `#/control/subjects.ts`), then `"none"`-distinct `"(none)"`. Master's
 *   closest equivalents (`summarizeAuditDecisions().byConsumer` with
 *   `consumerKey ?? "none"`, `consumerDecisions` with an exact `groupId`
 *   match) cover neither the fallback chain nor the explicit unknown marker.
 * - `filterByConsumerKey` matches on that fallback key (not an exact-field
 *   match like `filterAuditEvents`) and passes everything through when no
 *   consumer is selected. Production import: `selectEscalations` in
 *   `#/components/dashboard-meta.ts`.
 * - `summarizeByConsumer` counts decisions per fallback key, sorted by count
 *   descending. Test-only import, kept as the audited contract for
 *   keyless/group-scoped aggregation.
 */

import { type AuditEvent, isAuditDecision } from "#/control/audit.ts";

export const UNKNOWN_CONSUMER = "(none)";

/**
 * Consumer key for one audit event: the dedicated field when present,
 * otherwise the policy subject group, otherwise the explicit unknown marker.
 */
export function consumerKeyOf(event: AuditEvent): string {
	if (event.consumerKey !== undefined && event.consumerKey.length > 0) {
		return event.consumerKey;
	}
	if (event.groupId !== undefined && event.groupId.length > 0) {
		return event.groupId;
	}
	return UNKNOWN_CONSUMER;
}

/** Decisions-only events attributable to one consumer key. */
export function filterByConsumerKey(
	events: readonly AuditEvent[],
	consumer: string | undefined,
): AuditEvent[] {
	if (consumer === undefined) {
		return [...events];
	}
	return events.filter((event) => consumerKeyOf(event) === consumer);
}

/**
 * Decision counts per consumer key, newest-agnostic, sorted by count
 * descending. Covers decisions only (see {@link isAuditDecision}) so
 * registration admissions and verdict-less notes never inflate a user.
 */
export function summarizeByConsumer(events: readonly AuditEvent[]): [string, number][] {
	const counts = new Map<string, number>();
	for (const event of events) {
		if (!isAuditDecision(event)) {
			continue;
		}
		const label = consumerKeyOf(event);
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}
