/**
 * Dashboard data assembly: merges the live policy projection with the seeded
 * metrics and computes the pooled aggregate plus per-consumer selection.
 * Pure so both the server function and the render tests share one path.
 */

import type { PolicySnapshot } from "#/control/policy/loader.ts";
import { FIXTURE_ESCALATIONS, FIXTURE_FEED_VERSION, fixtureConsumerMetrics } from "#/dashboard/fixture.ts";
import { summarizePolicy } from "#/dashboard/policy-view.ts";
import {
	ALL_CONSUMERS,
	type BudgetRuleView,
	type BudgetSeriesPoint,
	type ConsumerMetrics,
	type DashboardData,
	type LatencyPercentiles,
	type ThreatBreakdownRow,
} from "#/dashboard/types.ts";
import type { Verdict } from "#/control/types.ts";

const VERDICTS: readonly Verdict[] = ["allow", "redact", "block", "escalate"];

function sumVerdicts(parts: readonly ConsumerMetrics[]): Record<Verdict, number> {
	const totals = { allow: 0, block: 0, escalate: 0, redact: 0 } as Record<Verdict, number>;
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

/** Build the complete dashboard payload from a policy snapshot. */
export function buildDashboardData(snapshot: PolicySnapshot, generatedAt: string): DashboardData {
	const policyView = summarizePolicy(snapshot, FIXTURE_FEED_VERSION);
	const consumerKeys = Object.keys(policyView.policy.consumers).sort();
	const byConsumer = fixtureConsumerMetrics(consumerKeys);
	const parts = consumerKeys.map((key) => byConsumer[key]).filter((part) => part !== undefined);
	return {
		aggregate: aggregateMetrics(parts),
		byConsumer,
		consumerKeys,
		escalations: FIXTURE_ESCALATIONS,
		feedVersion: policyView.feedVersion,
		generatedAt,
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
