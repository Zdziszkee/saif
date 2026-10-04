/**
 * Seeded dashboard metrics (task 11.1: "renders with seeded data").
 *
 * Verdict counts, redaction counts, and the escalation queue below are
 * fallbacks only: `data.ts` overrides them from the real audit sink whenever
 * a consumer has recorded decisions. The rest stays fixture-fed until its
 * queries land (tasks 10.2/7.x): threat breakdown and latency percentiles
 * wait on the metrics queries (10.2), budget rules and the cost/token series
 * wait on the budget instrumentation queries (7.x). Values are deterministic
 * so dashboard render tests can assert against them.
 */

import type {
	BudgetRuleView,
	BudgetSeriesPoint,
	ConsumerMetrics,
	EscalationRow,
	ThreatBreakdownRow,
} from "#/dashboard/types.ts";

export const FIXTURE_FEED_VERSION = "signatures.fixture.2026.10.03-3";

const HOURS = 12;
const SERIES_START_MS = Date.parse("2026-10-03T12:00:00.000Z");
const HOUR_MS = 3_600_000;
const WAVE_SPAN = 5;
const COST_PER_WAVE = 0.35;
const CENTS_DIGITS = 2;
const TOKENS_PER_WAVE = 1800;

/** Deterministic hourly cost/token series for one consumer. */
function budgetSeries(consumerIndex: number): BudgetSeriesPoint[] {
	return Array.from({ length: HOURS }, (_, hour) => {
		const at = new Date(SERIES_START_MS + hour * HOUR_MS).toISOString();
		const wave = ((hour + consumerIndex) % WAVE_SPAN) + 1;
		return {
			at,
			costUsd: Number((wave * (consumerIndex + 1) * COST_PER_WAVE).toFixed(CENTS_DIGITS)),
			tokens: wave * (consumerIndex + 1) * TOKENS_PER_WAVE,
		};
	});
}

const FIXTURE_VERDICTS: Readonly<Record<string, ConsumerMetrics["verdicts"]>> = {
	alice: { allow: 1180, block: 18, escalate: 3, redact: 42 },
	analyst: { allow: 640, block: 6, escalate: 1, redact: 27 },
	"deploy-bot": { allow: 2450, block: 61, escalate: 9, redact: 88 },
};

const FIXTURE_REDACTIONS: Readonly<Record<string, number>> = {
	alice: 42,
	analyst: 27,
	"deploy-bot": 88,
};

/** Fixture-backed seam (task 10.2): latency queries pending. */
const FIXTURE_LATENCY: Readonly<Record<string, ConsumerMetrics["latency"]>> = {
	alice: { p50: 38, p95: 121, p99: 260 },
	analyst: { p50: 44, p95: 140, p99: 305 },
	"deploy-bot": { p50: 31, p95: 96, p99: 210 },
};

/** Fixture-backed seam (task 10.2): threat breakdown queries pending. */
const FIXTURE_THREATS: Readonly<Record<string, ThreatBreakdownRow[]>> = {
	alice: [
		{ blocked: 3, category: "pii.email", controlId: "detection", flagged: 1, redacted: 19 },
		{ blocked: 2, category: "secret.api_key", controlId: "detection", flagged: 0, redacted: 6 },
		{
			blocked: 8,
			category: "prompt_injection",
			controlId: "signatures",
			flagged: 2,
			redacted: 4,
		},
		{ blocked: 5, category: "jailbreak", controlId: "semantic", flagged: 1, redacted: 3 },
	],
	analyst: [
		{ blocked: 1, category: "pii.email", controlId: "detection", flagged: 0, redacted: 12 },
		{ blocked: 2, category: "pii.card", controlId: "detection", flagged: 1, redacted: 7 },
		{
			blocked: 3,
			category: "data_exfiltration",
			controlId: "semantic",
			flagged: 2,
			redacted: 2,
		},
	],
	"deploy-bot": [
		{ blocked: 9, category: "secret.api_key", controlId: "detection", flagged: 1, redacted: 30 },
		{ blocked: 14, category: "malicious_code", controlId: "signatures", flagged: 3, redacted: 8 },
		{
			blocked: 21,
			category: "prompt_injection",
			controlId: "signatures",
			flagged: 6,
			redacted: 12,
		},
		{
			blocked: 12,
			category: "supply_chain",
			controlId: "signatures",
			flagged: 2,
			redacted: 5,
		},
		{ blocked: 5, category: "jailbreak", controlId: "semantic", flagged: 1, redacted: 4 },
	],
};

/** Fixture-backed seam (task 7.x): budget usage queries pending. */
const FIXTURE_BUDGET: Readonly<Record<string, BudgetRuleView[]>> = {
	alice: [
		{
			consumerKey: "alice",
			limit: 250_000,
			metric: "tokens",
			modelScope: "*",
			period: "day",
			used: 148_200,
		},
		{
			consumerKey: "alice",
			limit: 20,
			metric: "costUsd",
			modelScope: "*",
			period: "month",
			used: 11.4,
		},
	],
	analyst: [
		{
			consumerKey: "analyst",
			limit: 500,
			metric: "requests",
			modelScope: "primary",
			period: "day",
			used: 287,
		},
	],
	"deploy-bot": [
		{
			consumerKey: "deploy-bot",
			limit: 600_000,
			metric: "computeTimeMs",
			modelScope: "*",
			period: "day",
			used: 412_000,
		},
	],
};

export const FIXTURE_ESCALATIONS: readonly EscalationRow[] = [
	{
		consumerKey: "deploy-bot",
		direction: "outbound",
		id: "esc-2026-10-03-014",
		reason: "semantic decisiveness below floor (data_exfiltration p=0.58)",
		seam: "mcp-tool",
		subject: "deploy-bot",
		timestamp: "2026-10-03T18:42:11.000Z",
	},
	{
		consumerKey: "alice",
		direction: "inbound",
		id: "esc-2026-10-03-013",
		reason: "signature suspect signals above threshold (invisible-char density)",
		seam: "chat",
		subject: "alice",
		timestamp: "2026-10-03T17:05:47.000Z",
	},
	{
		consumerKey: "deploy-bot",
		direction: "inbound",
		id: "esc-2026-10-03-011",
		reason: "semantic failure verdict applied (classifier timeout)",
		seam: "guard-api",
		subject: "deploy-bot",
		timestamp: "2026-10-03T15:22:03.000Z",
	},
	{
		consumerKey: "analyst",
		direction: "outbound",
		id: "esc-2026-10-03-009",
		reason: "residual sensitive span in egress state",
		seam: "chat",
		subject: "analyst",
		timestamp: "2026-10-03T13:58:29.000Z",
	},
];

/** Seeded per-consumer metrics, keyed exactly like the policy consumers. */
export function fixtureConsumerMetrics(
	consumerKeys: readonly string[],
): Record<string, ConsumerMetrics> {
	const result: Record<string, ConsumerMetrics> = {};
	consumerKeys.forEach((key, index) => {
		result[key] = {
			budget: FIXTURE_BUDGET[key] ?? [],
			budgetSeries: budgetSeries(index),
			latency: FIXTURE_LATENCY[key] ?? { p50: 40, p95: 130, p99: 280 },
			redactions: FIXTURE_REDACTIONS[key] ?? 0,
			threats: FIXTURE_THREATS[key] ?? [],
			verdicts: FIXTURE_VERDICTS[key] ?? { allow: 0, block: 0, escalate: 0, redact: 0 },
		};
	});
	return result;
}
