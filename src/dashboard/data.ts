/**
 * Dashboard data assembly: merges the live policy projection, the real audit
 * seam, and the seeded metrics, then computes the pooled aggregate plus
 * per-consumer selection. Pure so both the server function and the render
 * tests share one path.
 *
 * Real vs fixture at this seam:
 * - Verdict counts, redaction counts, and the escalation queue come from the
 *   audit sink (`#/control/audit.ts`) for every consumer with recorded
 *   decisions, and fall back to the seeded fixture values otherwise (the
 *   spec's verify line is "renders with seeded data").
 * - Threat breakdown (by control/category), budget usage vs limits, and
 *   latency percentiles stay fixture-fed until their queries land (tasks
 *   10.2/7.x) — see `fixture.ts`.
 */

import { type AuditEvent, filterAuditEvents, isAuditDecision } from "#/control/audit.ts";
import type { PolicySnapshot } from "#/control/policy/loader.ts";
import type { Direction, Verdict } from "#/control/types.ts";
import {
	FIXTURE_ESCALATIONS,
	FIXTURE_FEED_VERSION,
	FIXTURE_PERSON_ROLES,
	fixtureConsumerMetrics,
} from "#/dashboard/fixture.ts";
import { summarizePolicy } from "#/dashboard/policy-view.ts";
import {
	ALL_CONSUMERS,
	type BudgetRuleView,
	type BudgetSeriesPoint,
	type ConsumerMetrics,
	type DashboardData,
	type EscalationRow,
	type LatencyPercentiles,
	type ThreatBreakdownRow,
} from "#/dashboard/types.ts";

const VERDICTS: readonly Verdict[] = ["allow", "redact", "block", "escalate"];

const ESCALATE_VERDICT: Verdict = "escalate";
const ESCALATION_ID_PREFIX = "esc";
const DEFAULT_ESCALATION_DIRECTION: Direction = "inbound";
const DEFAULT_ESCALATION_REASON = "escalate verdict recorded";
const DEFAULT_ESCALATION_SEAM = "unknown";

function emptyVerdicts(): Record<Verdict, number> {
	return { allow: 0, block: 0, escalate: 0, redact: 0 };
}

function sumVerdicts(parts: readonly ConsumerMetrics[]): Record<Verdict, number> {
	const totals = emptyVerdicts();
	for (const part of parts) {
		for (const verdict of VERDICTS) {
			totals[verdict] += part.verdicts[verdict];
		}
	}
	return totals;
}

function mergeThreats(parts: readonly ConsumerMetrics[]): ThreatBreakdownRow[] {
	const rows = new Map<string, ThreatBreakdownRow>();
	for (const part of parts) {
		for (const threat of part.threats) {
			const key = `${threat.controlId}|${threat.category}`;
			const current = rows.get(key);
			if (current === undefined) {
				rows.set(key, { ...threat });
			} else {
				current.blocked += threat.blocked;
				current.flagged += threat.flagged;
				current.redacted += threat.redacted;
			}
		}
	}
	return [...rows.values()].sort((left, right) => right.blocked - left.blocked);
}

function mergeBudget(parts: readonly ConsumerMetrics[]): BudgetRuleView[] {
	return parts.flatMap((part) => part.budget);
}

function mergeSeries(parts: readonly ConsumerMetrics[]): BudgetSeriesPoint[] {
	const byTime = new Map<string, BudgetSeriesPoint>();
	for (const part of parts) {
		for (const point of part.budgetSeries) {
			const current = byTime.get(point.at);
			if (current === undefined) {
				byTime.set(point.at, { ...point });
			} else {
				current.costUsd = Number((current.costUsd + point.costUsd).toFixed(2));
				current.tokens += point.tokens;
			}
		}
	}
	return [...byTime.values()].sort((left, right) => left.at.localeCompare(right.at));
}

function worstLatency(parts: readonly ConsumerMetrics[]): LatencyPercentiles {
	const latency: LatencyPercentiles = { p50: 0, p95: 0, p99: 0 };
	for (const part of parts) {
		latency.p50 = Math.max(latency.p50, part.latency.p50);
		latency.p95 = Math.max(latency.p95, part.latency.p95);
		latency.p99 = Math.max(latency.p99, part.latency.p99);
	}
	return latency;
}

/** Decisions recorded for one consumer key (`groupId === consumerKey`). */
function consumerDecisions(
	events: readonly AuditEvent[],
	consumerKey: string,
): readonly AuditEvent[] {
	return filterAuditEvents(events, { groupId: consumerKey }).filter(isAuditDecision);
}

function verdictsFromAudit(decisions: readonly AuditEvent[]): Record<Verdict, number> {
	const counts = emptyVerdicts();
	for (const event of decisions) {
		if (event.verdict !== undefined) {
			counts[event.verdict] += 1;
		}
	}
	return counts;
}

function redactionsFromAudit(decisions: readonly AuditEvent[]): number {
	let total = 0;
	for (const event of decisions) {
		total += event.redactionCount ?? 0;
	}
	return total;
}

/** Map one escalate decision onto the escalation queue row shape. */
function escalationFromDecision(consumerKey: string, event: AuditEvent): EscalationRow {
	return {
		consumerKey,
		direction: DEFAULT_ESCALATION_DIRECTION,
		id: event.interactionId ?? `${ESCALATION_ID_PREFIX}-${consumerKey}-${event.timestamp}`,
		reason: event.detail ?? DEFAULT_ESCALATION_REASON,
		seam: event.seam ?? DEFAULT_ESCALATION_SEAM,
		subject: event.groupId ?? consumerKey,
		timestamp: event.timestamp,
	};
}

function escalationsFromAudit(
	decisions: ReadonlyMap<string, readonly AuditEvent[]>,
): EscalationRow[] {
	const rows: EscalationRow[] = [];
	for (const [consumerKey, events] of decisions) {
		for (const event of filterAuditEvents(events, { verdict: ESCALATE_VERDICT })) {
			rows.push(escalationFromDecision(consumerKey, event));
		}
	}
	return rows;
}

function newestFirst(left: EscalationRow, right: EscalationRow): number {
	return right.timestamp.localeCompare(left.timestamp);
}

/** Person-to-role mapping from decision events (`userId` → `groupId`).
 * Audit order is oldest first, so later assignments overwrite earlier ones
 * and the last decision wins. Events missing either field are skipped. */
function personRolesFromAudit(events: readonly AuditEvent[]): Record<string, string> {
	const roles: Record<string, string> = { ...FIXTURE_PERSON_ROLES };
	for (const event of events) {
		if (!isAuditDecision(event)) {
			continue;
		}
		const { groupId, userId } = event;
		if (userId === undefined || groupId === undefined) {
			continue;
		}
		roles[userId] = groupId;
	}
	return Object.fromEntries(
		Object.entries(roles).sort(([left], [right]) => left.localeCompare(right)),
	);
}

/** Pool per-consumer metrics into the aggregate view. */
export function aggregateMetrics(parts: readonly ConsumerMetrics[]): ConsumerMetrics {
	return {
		budget: mergeBudget(parts),
		budgetSeries: mergeSeries(parts),
		latency: worstLatency(parts),
		redactions: parts.reduce((total, part) => total + part.redactions, 0),
		threats: mergeThreats(parts),
		verdicts: sumVerdicts(parts),
	};
}

/**
 * Build the complete dashboard payload from a policy snapshot. Audit events
 * supply the real verdict counts, redaction counts, and escalation queue for
 * consumers with recorded decisions; every other consumer (and seam) falls
 * back to the seeded fixture so the dashboard always renders.
 */
export function buildDashboardData(
	snapshot: PolicySnapshot,
	generatedAt: string,
	auditEvents: readonly AuditEvent[] = [],
): DashboardData {
	const policyView = summarizePolicy(snapshot, FIXTURE_FEED_VERSION);
	const consumerKeys = Object.keys(policyView.policy.consumers).sort();
	const byConsumer = fixtureConsumerMetrics(consumerKeys);
	const decisions = new Map<string, readonly AuditEvent[]>();
	for (const key of consumerKeys) {
		const derived = consumerDecisions(auditEvents, key);
		if (derived.length === 0) {
			continue;
		}
		decisions.set(key, derived);
		const metrics = byConsumer[key];
		if (metrics !== undefined) {
			metrics.verdicts = verdictsFromAudit(derived);
			metrics.redactions = redactionsFromAudit(derived);
		}
	}
	const parts = consumerKeys.map((key) => byConsumer[key]).filter((part) => part !== undefined);
	const escalations = [
		...escalationsFromAudit(decisions),
		...FIXTURE_ESCALATIONS.filter((row) => !decisions.has(row.consumerKey)),
	].sort(newestFirst);
	return {
		aggregate: aggregateMetrics(parts),
		byConsumer,
		consumerKeys,
		escalations,
		feedVersion: policyView.feedVersion,
		generatedAt,
		personRoles: personRolesFromAudit(auditEvents),
		policy: policyView.policy,
		policyVersion: policyView.policyVersion,
	};
}

/** Select the metrics shown for a consumer key, or the pooled aggregate. */
export function selectMetrics(data: DashboardData, consumer: string): ConsumerMetrics {
	if (consumer === ALL_CONSUMERS) {
		return data.aggregate;
	}
	return data.byConsumer[consumer] ?? data.aggregate;
}

/** Select the escalations shown for a consumer key, or all of them. */
export function selectEscalations(data: DashboardData, consumer: string) {
	if (consumer === ALL_CONSUMERS) {
		return data.escalations;
	}
	return data.escalations.filter((row) => row.consumerKey === consumer);
}
