/**
 * Per-consumer shaping for the security dashboard.
 *
 * The audit sink is append-only and its event schema is owned by
 * `#/control/audit.ts`, which may or may not carry a dedicated `consumerKey`
 * field yet (concurrent agents are adding it). Everything here reads the key
 * defensively — preferring `consumerKey` when present and falling back to the
 * policy subject (known consumer keys govern as a subject of the same name,
 * see `#/control/subjects.ts`) and finally `"(none)"` — so the dashboard
 * keeps working whatever the schema state is.
 */

import { type AuditEvent, isAuditDecision } from "#/control/audit.ts";

export const UNKNOWN_CONSUMER = "(none)";

type MaybeKeyedEvent = AuditEvent & { consumerKey?: unknown };

/**
 * Consumer key for one audit event: the dedicated field when present,
 * otherwise the policy subject, otherwise the explicit unknown marker.
 */
export function consumerKeyOf(event: AuditEvent): string {
	const key = (event as MaybeKeyedEvent).consumerKey;
	if (typeof key === "string" && key.length > 0) {
		return key;
	}
	return event.subject ?? UNKNOWN_CONSUMER;
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
