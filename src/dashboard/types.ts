/**
 * Dashboard data model (security-observability spec, "Dashboard" requirement).
 *
 * The shape mirrors the live dashboard queries: per-consumer verdict counts,
 * threat breakdown by control and category, budget usage against configured
 * limits, latency percentiles, and the escalation queue. Every metric is live:
 * `data.ts` derives verdicts, threats, latency, budget usage, series, and
 * escalations from the audit sink and the policy snapshot, reporting zeros
 * and empty rows when a consumer has no recorded activity.
 */

import type { Direction, Verdict } from "#/control/types.ts";

export type BudgetMetric = "computeTimeMs" | "costUsd" | "requests" | "tokens";
export type BudgetPeriod = "day" | "hour" | "month";

export type ControlTier =
	| "allowlist"
	| "budget"
	| "detection"
	| "redaction"
	| "semantic"
	| "shape"
	| "signatures";

export type ThresholdControl = "detection" | "semantic" | "signatures";

export interface LatencyPercentiles {
	p50: number;
	p95: number;
	p99: number;
}

/** One threat breakdown row: control and category crossed with counts. */
export interface ThreatBreakdownRow {
	blocked: number;
	category: string;
	controlId: string;
	flagged: number;
	redacted: number;
}

export interface BudgetSeriesPoint {
	at: string;
	costUsd: number;
	tokens: number;
}

/** One configured budget rule with its usage against the limit. */
export interface BudgetRuleView {
	consumerKey: string;
	limit: number;
	metric: BudgetMetric;
	modelScope: string;
	period: BudgetPeriod;
	used: number;
}

/** Metrics for one consumer key (or the pooled aggregate). */
export interface ConsumerMetrics {
	budget: readonly BudgetRuleView[];
	budgetSeries: readonly BudgetSeriesPoint[];
	latency: LatencyPercentiles;
	redactions: number;
	threats: readonly ThreatBreakdownRow[];
	verdicts: Record<Verdict, number>;
}

export interface EscalationRow {
	consumerKey: string;
	direction: Direction;
	id: string;
	reason: string;
	seam: string;
	subject: string;
	timestamp: string;
}

export interface ControlSummary {
	detail: string;
	enabled: boolean;
	id: string;
	tier: ControlTier;
}

export interface ProfileSummary {
	blockThresholds: Readonly<Record<ThresholdControl, Readonly<Record<Direction, number>>>>;
	enabled: Readonly<Record<ThresholdControl, boolean>>;
	name: string;
}

export interface PolicyView {
	consumers: Readonly<Record<string, string>>;
	controls: readonly ControlSummary[];
	defaultProfile: string;
	failureVerdict: Verdict;
	profiles: readonly ProfileSummary[];
}

export interface DashboardData {
	aggregate: ConsumerMetrics;
	byConsumer: Readonly<Record<string, ConsumerMetrics>>;
	consumerKeys: readonly string[];
	escalations: readonly EscalationRow[];
	feedVersion: string;
	generatedAt: string;
	personRoles: Readonly<Record<string, string>>;
	policy: PolicyView;
	policyVersion: string;
	semanticVersion: string;
}

export const ALL_CONSUMERS = "all";
