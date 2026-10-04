/**
 * Dashboard data assembly: merges the live policy projection with the real
 * audit seam and live usage. Pure so both the server function and the render
 * tests share one path.
 *
 * Live seams (no fixtures):
 * - Verdict counts, redaction counts, and the escalation queue come from the
 *   audit sink (`#/control/audit.ts`) decisions per consumer.
 * - Threat breakdown comes from audit hits per decision event, grouped by
 *   control and category; empty when no hits are recorded.
 * - Latency percentiles come from audit `latencyMs` samples per consumer
 *   (nearest-rank p50/p95/p99); zeros when no samples exist. The aggregate
 *   pools every sample instead of taking the max of per-consumer buckets.
 * - Budget limits come from the policy snapshot budget rules
 *   (`controls.budget.rules`, `used` starts at 0); usage aggregates real
 *   decisions (requests, prompt+completion tokens, cost, latency). The series
 *   buckets real events by hour; empty when no usage is recorded.
 */

import { type AuditEvent, filterAuditEvents, isAuditDecision } from "#/control/audit.ts";
import type { PolicySnapshot } from "#/control/policy/loader.ts";
import type { Policy } from "#/control/policy/schema.ts";
import type { Direction, Verdict } from "#/control/types.ts";
import { summarizePolicy } from "#/dashboard/policy-view.ts";
import {
	ALL_CONSUMERS,
	type BudgetMetric,
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

const PERCENT_SCALE = 100;
const P50 = 50;
const P95 = 95;
const P99 = 99;
const CENTS_DIGITS = 2;

/** Extra audit fields the live dashboard reads. Agent A is landing these on
 * `AuditEvent`; the `unknown` read shape keeps this module compiling with or
 * without them on the type. */
interface AuditExtras {
	completionTokens?: unknown;
	costUsd?: unknown;
	direction?: unknown;
	hits?: unknown;
	latencyMs?: unknown;
	model?: unknown;
	promptTokens?: unknown;
}

interface HitLike {
	category?: unknown;
	controlId?: unknown;
	kind?: unknown;
}

function asFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function extrasOf(event: AuditEvent): AuditExtras {
	return event as AuditEvent & AuditExtras;
}

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
				current.costUsd = Number((current.costUsd + point.costUsd).toFixed(CENTS_DIGITS));
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

/** Nearest-rank percentiles over latency samples; zeros when empty. */
export function percentiles(samples: readonly number[]): LatencyPercentiles {
	if (samples.length === 0) {
		return { p50: 0, p95: 0, p99: 0 };
	}
	const sorted = [...samples].sort((left, right) => left - right);
	const at = (percent: number): number => {
		const rank = Math.ceil((percent / PERCENT_SCALE) * sorted.length);
		const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
		return sorted[index] ?? 0;
	};
	return { p50: at(P50), p95: at(P95), p99: at(P99) };
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

function hitEntries(event: AuditEvent): { category: string; controlId: string }[] {
	const raw = extrasOf(event).hits;
	if (!Array.isArray(raw)) {
		return [];
	}
	const entries: { category: string; controlId: string }[] = [];
	for (const item of raw) {
		if (typeof item !== "object" || item === null) {
			continue;
		}
		const hit = item as HitLike;
		entries.push({
			category: asNonEmptyString(hit.category) ?? asNonEmptyString(hit.kind) ?? "unknown",
			controlId: asNonEmptyString(hit.controlId) ?? asNonEmptyString(event.controlId) ?? "unknown",
		});
	}
	return entries;
}

function threatRowFor(
	rows: Map<string, ThreatBreakdownRow>,
	controlId: string,
	category: string,
): ThreatBreakdownRow {
	const key = `${controlId}|${category}`;
	const existing = rows.get(key);
	if (existing !== undefined) {
		return existing;
	}
	const row: ThreatBreakdownRow = { blocked: 0, category, controlId, flagged: 0, redacted: 0 };
	rows.set(key, row);
	return row;
}

function applyThreatCounts(
	row: ThreatBreakdownRow,
	verdict: Verdict | undefined,
	redactedEvent: boolean,
	isFirstHit: boolean,
): void {
	if (verdict === "block" || verdict === "escalate") {
		row.blocked += 1;
	}
	if (verdict === "allow" || verdict === "redact") {
		row.flagged += 1;
	}
	if (redactedEvent && isFirstHit) {
		row.redacted += 1;
	}
}

/** Threat rows from audit hits: one count per hit in each decision event.
 * Blocking verdicts (`block`/`escalate`) increment `blocked`, forwarding
 * verdicts (`allow`/`redact`) increment `flagged`, and a redacted event
 * attributes one `redacted` to its first hit (capped once per event).
 * Empty when no hits are recorded. */
function threatsFromAudit(decisions: readonly AuditEvent[]): ThreatBreakdownRow[] {
	const rows = new Map<string, ThreatBreakdownRow>();
	for (const event of decisions) {
		const hits = hitEntries(event);
		if (hits.length === 0) {
			continue;
		}
		const redactedEvent = (event.redactionCount ?? 0) > 0;
		for (const [index, hit] of hits.entries()) {
			applyThreatCounts(
				threatRowFor(rows, hit.controlId, hit.category),
				event.verdict,
				redactedEvent,
				index === 0,
			);
		}
	}
	return [...rows.values()].sort((left, right) => right.blocked - left.blocked);
}

function latencyFromAudit(decisions: readonly AuditEvent[]): LatencyPercentiles {
	const samples: number[] = [];
	for (const event of decisions) {
		const latencyMs = asFiniteNumber(extrasOf(event).latencyMs);
		if (latencyMs !== undefined) {
			samples.push(latencyMs);
		}
	}
	return percentiles(samples);
}

type BudgetRule = Policy["controls"]["budget"]["rules"][number];

const BUDGET_METRICS: readonly BudgetMetric[] = ["tokens", "costUsd", "requests", "computeTimeMs"];

interface BudgetTotals {
	computeTimeMs: number;
	costUsd: number;
	requests: number;
	tokens: number;
}

/** Real usage for one model scope: `"*"` pools every decision, a named scope
 * keeps only decisions whose `model` matches (model-less events are skipped). */
function totalsForScope(decisions: readonly AuditEvent[], modelScope: string): BudgetTotals {
	const totals: BudgetTotals = { computeTimeMs: 0, costUsd: 0, requests: 0, tokens: 0 };
	for (const event of decisions) {
		const extras = extrasOf(event);
		if (modelScope !== "*" && asNonEmptyString(extras.model) !== modelScope) {
			continue;
		}
		totals.requests += 1;
		totals.tokens +=
			(asFiniteNumber(extras.promptTokens) ?? 0) + (asFiniteNumber(extras.completionTokens) ?? 0);
		totals.costUsd += asFiniteNumber(extras.costUsd) ?? 0;
		totals.computeTimeMs += asFiniteNumber(extras.latencyMs) ?? 0;
	}
	return totals;
}

/** Budget views for one consumer: limits from the policy snapshot rules for
 * `rule.key === consumerKey`, `used` aggregated from real decisions. Rules
 * carrying several limits expand to one view per metric. */
function budgetViewsForConsumer(
	consumerKey: string,
	rules: readonly BudgetRule[],
	decisions: readonly AuditEvent[],
): BudgetRuleView[] {
	const views: BudgetRuleView[] = [];
	for (const rule of rules) {
		if (rule.key !== consumerKey) {
			continue;
		}
		for (const metric of BUDGET_METRICS) {
			const limit = rule[metric];
			if (limit === undefined) {
				continue;
			}
			const totals = totalsForScope(decisions, rule.modelScope);
			const raw = totals[metric];
			views.push({
				consumerKey: rule.key,
				limit,
				metric,
				modelScope: rule.modelScope,
				period: rule.period,
				used: metric === "costUsd" ? Number(raw.toFixed(CENTS_DIGITS)) : raw,
			});
		}
	}
	return views;
}

/** Truncate an event timestamp to its UTC hour bucket, if parseable. */
function hourBucketKey(timestamp: string): string | undefined {
	const time = Date.parse(timestamp);
	if (Number.isNaN(time)) {
		return;
	}
	const hour = new Date(time);
	hour.setUTCMinutes(0, 0, 0);
	return hour.toISOString();
}

function accumulateSeriesPoint(
	byHour: Map<string, { costUsd: number; tokens: number }>,
	at: string,
	tokens: number,
	costUsd: number,
): void {
	const current = byHour.get(at);
	if (current === undefined) {
		byHour.set(at, { costUsd, tokens });
	} else {
		current.costUsd += costUsd;
		current.tokens += tokens;
	}
}

function hasRecordedUsage(
	byHour: ReadonlyMap<string, { costUsd: number; tokens: number }>,
): boolean {
	for (const point of byHour.values()) {
		if (point.tokens > 0 || point.costUsd > 0) {
			return true;
		}
	}
	return false;
}

function sortedSeriesPoints(
	byHour: ReadonlyMap<string, { costUsd: number; tokens: number }>,
): BudgetSeriesPoint[] {
	return [...byHour.entries()]
		.map(([at, point]) => ({
			at,
			costUsd: Number(point.costUsd.toFixed(CENTS_DIGITS)),
			tokens: point.tokens,
		}))
		.sort((left, right) => left.at.localeCompare(right.at));
}

/** Hourly cost/token series from real events; empty when no usage recorded. */
function budgetSeriesFromAudit(decisions: readonly AuditEvent[]): BudgetSeriesPoint[] {
	if (decisions.length === 0) {
		return [];
	}
	const byHour = new Map<string, { costUsd: number; tokens: number }>();
	for (const event of decisions) {
		const at = hourBucketKey(event.timestamp);
		if (at === undefined) {
			continue;
		}
		const extras = extrasOf(event);
		accumulateSeriesPoint(
			byHour,
			at,
			(asFiniteNumber(extras.promptTokens) ?? 0) + (asFiniteNumber(extras.completionTokens) ?? 0),
			asFiniteNumber(extras.costUsd) ?? 0,
		);
	}
	if (!hasRecordedUsage(byHour)) {
		return [];
	}
	return sortedSeriesPoints(byHour);
}

/** Map one escalate decision onto the escalation queue row shape, using the
 * real direction, seam, and reason recorded on the event. */
function escalationFromDecision(consumerKey: string, event: AuditEvent): EscalationRow {
	const rawDirection = asNonEmptyString(extrasOf(event).direction);
	const direction: Direction =
		rawDirection === "inbound" || rawDirection === "outbound"
			? rawDirection
			: DEFAULT_ESCALATION_DIRECTION;
	return {
		consumerKey,
		direction,
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
	const roles: Record<string, string> = {};
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

/** Pool per-consumer metrics into the aggregate view. Latency merges by max
 * for direct callers; `buildDashboardData` overrides the aggregate with the
 * pooled percentile over every sample (more truthful than max). */
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
 * Build the complete dashboard payload from a policy snapshot and the live
 * audit sink. Every consumer key comes from the policy; every metric comes
 * from recorded decisions, policy budget rules, and the caller-supplied feed
 * version. Consumers without decisions report zeros and empty rows so the
 * dashboard renders the "no activity" states.
 */
export function buildDashboardData(
	snapshot: PolicySnapshot,
	generatedAt: string,
	auditEvents: readonly AuditEvent[] = [],
	feedVersion = "unavailable",
): DashboardData {
	const policyView = summarizePolicy(snapshot, feedVersion);
	const consumerKeys = Object.keys(policyView.policy.consumers).sort();
	const rules = snapshot.policy.controls.budget.rules;
	const byConsumer: Record<string, ConsumerMetrics> = {};
	const decisions = new Map<string, readonly AuditEvent[]>();
	const allLatency: number[] = [];
	for (const key of consumerKeys) {
		const derived = consumerDecisions(auditEvents, key);
		decisions.set(key, derived);
		for (const event of derived) {
			const latencyMs = asFiniteNumber(extrasOf(event).latencyMs);
			if (latencyMs !== undefined) {
				allLatency.push(latencyMs);
			}
		}
		byConsumer[key] = {
			budget: budgetViewsForConsumer(key, rules, derived),
			budgetSeries: budgetSeriesFromAudit(derived),
			latency: latencyFromAudit(derived),
			redactions: redactionsFromAudit(derived),
			threats: threatsFromAudit(derived),
			verdicts: verdictsFromAudit(derived),
		};
	}
	const parts = consumerKeys
		.map((key) => byConsumer[key])
		.filter((part): part is ConsumerMetrics => part !== undefined);
	const pooled = aggregateMetrics(parts);
	const escalations = escalationsFromAudit(decisions).sort(newestFirst);
	return {
		aggregate: { ...pooled, latency: percentiles(allLatency) },
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
