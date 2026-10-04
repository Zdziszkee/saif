/**
 * Dashboard data assembly tests: live derivation from the audit seam.
 *
 * `buildDashboardData` merges the live policy projection with decisions read
 * from the audit sink — no seeded metrics. An empty sink yields zeroed
 * verdicts, empty threat/latency/budget rows, an empty escalation queue, and
 * an empty person roster. Seeded `interaction` decisions drive every section:
 * verdict counts, redaction totals, threat rows grouped by control|category
 * from per-decision `hits`, nearest-rank latency percentiles from
 * `latencyMs`, budget `used` against the policy snapshot rules from usage
 * fields, hourly cost/token series, the escalation queue (newest first,
 * carrying each decision's own direction/seam/reason), and the person roster
 * (last decision wins).
 */
import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { type AuditEvent, auditEvent } from "#/control/audit.ts";
import type { PolicySnapshot } from "#/control/policy/loader.ts";
import type { Policy } from "#/control/policy/schema.ts";
import { parsePolicy } from "#/control/policy/schema.ts";
import type { Direction, Verdict } from "#/control/types.ts";
import {
	aggregateMetrics,
	buildDashboardData,
	percentiles,
	selectEscalations,
	selectMetrics,
} from "#/dashboard/data.ts";
import {
	formatCount,
	formatMs,
	formatTimeLabel,
	formatTimestamp,
	formatTokens,
	formatUsd,
	usagePercent,
} from "#/dashboard/format.ts";
import { ALL_CONSUMERS, type ConsumerMetrics, type DashboardData } from "#/dashboard/types.ts";

const GENERATED_AT = "2026-10-04T20:00:00.000Z";
const TEST_POLICY_VERSION = "sha256.test-policy-version";
const TEST_FEED_VERSION = "feed.test.live-1";

async function loadSnapshot(): Promise<PolicySnapshot> {
	const text = await readFile(new URL("../policy.json", import.meta.url), "utf8");
	const document: unknown = JSON.parse(text);
	const parsed = parsePolicy(document);
	if (!parsed.success) {
		throw new Error(
			`policy.json failed validation: ${parsed.issues.map((issue) => issue.message).join("; ")}`,
		);
	}
	return { policy: parsed.policy, policyVersion: TEST_POLICY_VERSION };
}

const SNAPSHOT = await loadSnapshot();

type BudgetRules = Policy["controls"]["budget"]["rules"];

/** Snapshot with budget rules keyed to the test consumers (the sample
 * policy.json rules are keyed to `user-1`, which matches no consumer). */
function snapshotWithBudget(rules: BudgetRules): PolicySnapshot {
	return {
		policy: {
			...SNAPSHOT.policy,
			controls: {
				...SNAPSHOT.policy.controls,
				budget: { ...SNAPSHOT.policy.controls.budget, rules },
			},
		},
		policyVersion: TEST_POLICY_VERSION,
	};
}

interface SeedHit {
	readonly category: string;
	readonly controlId: string;
	readonly kind: string;
}

function decision(input: {
	readonly completionTokens?: number;
	readonly consumerKey?: string;
	readonly controlId?: string;
	readonly costUsd?: number;
	readonly detail?: string;
	readonly direction?: Direction;
	readonly groupId?: string;
	readonly hits?: SeedHit[];
	readonly interactionId?: string;
	readonly kind?: AuditEvent["kind"];
	readonly latencyMs?: number;
	readonly model?: string;
	readonly promptTokens?: number;
	readonly redactionCount?: number;
	readonly seam?: string;
	readonly timestamp: string;
	readonly userId?: string;
	readonly verdict?: Verdict;
}): AuditEvent {
	const { kind, timestamp, ...fields } = input;
	return { ...auditEvent(kind ?? "interaction", { ...fields }), timestamp };
}

function zeroMetrics(): ConsumerMetrics {
	return {
		budget: [],
		budgetSeries: [],
		latency: { p50: 0, p95: 0, p99: 0 },
		redactions: 0,
		threats: [],
		verdicts: { allow: 0, block: 0, escalate: 0, redact: 0 },
	};
}

function metricsFor(data: DashboardData, key: string): ConsumerMetrics {
	const metrics = data.byConsumer[key];
	if (metrics === undefined) {
		throw new Error(`missing consumer metrics for ${key}`);
	}
	return metrics;
}

/** Live seed: four hr decisions, three manager decisions, two
 * software-developer decisions, plus noise the dashboard must ignore (a
 * verdict-less note, a registration admission, and a control failure). */
function seedLiveEvents(): readonly AuditEvent[] {
	return [
		decision({
			completionTokens: 20,
			consumerKey: "hr",
			controlId: "detection",
			costUsd: 0.05,
			groupId: "hr",
			hits: [{ category: "live.probe.injection", controlId: "detection", kind: "pii" }],
			interactionId: "hr-allow-1",
			latencyMs: 10,
			model: "primary",
			promptTokens: 100,
			seam: "guard-api",
			timestamp: "2026-10-04T10:05:00.000Z",
			userId: "alice",
			verdict: "allow",
		}),
		decision({
			completionTokens: 40,
			consumerKey: "hr",
			controlId: "detection",
			costUsd: 0.1,
			groupId: "hr",
			hits: [{ category: "live.probe.pii", controlId: "detection", kind: "pii" }],
			interactionId: "hr-redact-1",
			latencyMs: 30,
			model: "primary",
			promptTokens: 200,
			redactionCount: 2,
			seam: "guard-api",
			timestamp: "2026-10-04T10:35:00.000Z",
			userId: "alice",
			verdict: "redact",
		}),
		decision({
			consumerKey: "hr",
			controlId: "signatures",
			groupId: "hr",
			hits: [
				{ category: "live.probe.injection", controlId: "signatures", kind: "prompt_injection" },
			],
			interactionId: "hr-block-1",
			latencyMs: 50,
			model: "primary",
			seam: "guard-api",
			timestamp: "2026-10-04T11:15:00.000Z",
			userId: "alice",
			verdict: "block",
		}),
		decision({
			completionTokens: 0,
			consumerKey: "hr",
			controlId: "semantic",
			costUsd: 0.01,
			detail: "hr queue needs review",
			direction: "outbound",
			groupId: "hr",
			hits: [{ category: "live.probe.exfil", controlId: "semantic", kind: "data_exfiltration" }],
			interactionId: "hr-esc-1",
			latencyMs: 70,
			model: "primary",
			promptTokens: 50,
			seam: "chat",
			timestamp: "2026-10-04T12:00:00.000Z",
			userId: "alice",
			verdict: "escalate",
		}),
		decision({
			completionTokens: 10,
			consumerKey: "manager",
			controlId: "pipeline",
			costUsd: 0.02,
			groupId: "manager",
			interactionId: "manager-allow-1",
			latencyMs: 20,
			model: "secondary",
			promptTokens: 10,
			seam: "guard-api",
			timestamp: "2026-10-04T10:10:00.000Z",
			userId: "bob",
			verdict: "allow",
		}),
		decision({
			consumerKey: "manager",
			controlId: "signatures",
			groupId: "manager",
			hits: [
				{ category: "live.probe.injection", controlId: "signatures", kind: "prompt_injection" },
			],
			interactionId: "manager-block-1",
			latencyMs: 60,
			model: "secondary",
			seam: "guard-api",
			timestamp: "2026-10-04T11:20:00.000Z",
			userId: "bob",
			verdict: "block",
		}),
		decision({
			consumerKey: "manager",
			controlId: "semantic",
			detail: "manager queue needs review",
			direction: "inbound",
			groupId: "manager",
			hits: [{ category: "live.probe.exfil", controlId: "semantic", kind: "data_exfiltration" }],
			interactionId: "manager-esc-1",
			latencyMs: 90,
			model: "secondary",
			seam: "mcp-tool",
			timestamp: "2026-10-04T13:30:00.000Z",
			userId: "bob",
			verdict: "escalate",
		}),
		decision({
			consumerKey: "software-developer",
			controlId: "pipeline",
			groupId: "software-developer",
			interactionId: "dev-allow-1",
			latencyMs: 40,
			model: "primary",
			seam: "guard-api",
			timestamp: "2026-10-04T10:40:00.000Z",
			userId: "carol",
			verdict: "allow",
		}),
		decision({
			consumerKey: "software-developer",
			controlId: "detection",
			groupId: "software-developer",
			hits: [{ category: "live.probe.pii", controlId: "detection", kind: "pii" }],
			interactionId: "dev-redact-1",
			latencyMs: 100,
			model: "primary",
			redactionCount: 4,
			seam: "guard-api",
			timestamp: "2026-10-04T14:00:00.000Z",
			userId: "carol",
			verdict: "redact",
		}),
		// Noise the dashboard must ignore: a verdict-less note, a
		// registration admission, and a control failure.
		decision({
			consumerKey: "hr",
			groupId: "hr",
			interactionId: "hr-note-1",
			seam: "guard-api",
			timestamp: "2026-10-04T15:00:00.000Z",
			userId: "alice",
		}),
		decision({
			consumerKey: "manager",
			groupId: "manager",
			interactionId: "manager-admission-1",
			kind: "registration",
			seam: "guard-api",
			timestamp: "2026-10-04T15:30:00.000Z",
			userId: "bob",
			verdict: "allow",
		}),
		decision({
			consumerKey: "hr",
			controlId: "semantic",
			detail: "classifier timeout",
			groupId: "hr",
			interactionId: "hr-failure-1",
			kind: "failure",
			seam: "guard-api",
			timestamp: "2026-10-04T16:00:00.000Z",
			userId: "alice",
			verdict: "escalate",
		}),
	];
}

const BUDGET_RULES: BudgetRules = [
	{ key: "hr", modelScope: "*", period: "day", requests: 50 },
	{ key: "hr", modelScope: "*", period: "day", tokens: 1000 },
	{ costUsd: 5, key: "hr", modelScope: "*", period: "month" },
	{ key: "manager", modelScope: "primary", period: "day", requests: 50 },
	{ computeTimeMs: 10_000, key: "manager", modelScope: "*", period: "day" },
];

const BUDGET_SNAPSHOT = snapshotWithBudget(BUDGET_RULES);
const EMPTY = buildDashboardData(SNAPSHOT, GENERATED_AT, []);
const SEEDED = buildDashboardData(BUDGET_SNAPSHOT, GENERATED_AT, seedLiveEvents());

describe("percentiles", () => {
	it("returns zeros when no samples exist", () => {
		expect(percentiles([])).toEqual({ p50: 0, p95: 0, p99: 0 });
	});

	it("computes nearest-rank p50/p95/p99", () => {
		expect(percentiles([10, 20, 30, 40, 50, 60, 70, 90, 100])).toEqual({
			p50: 50,
			p95: 100,
			p99: 100,
		});
	});

	it("resolves every bucket to the single sample", () => {
		expect(percentiles([42])).toEqual({ p50: 42, p95: 42, p99: 42 });
	});

	it("sorts samples before ranking", () => {
		expect(percentiles([70, 10, 50, 30])).toEqual({ p50: 30, p95: 70, p99: 70 });
	});
});

describe("aggregateMetrics", () => {
	it("returns zeros and empty rows for no parts", () => {
		expect(aggregateMetrics([])).toEqual(zeroMetrics());
	});

	it("sums verdicts and redactions across consumers", () => {
		const pooled = aggregateMetrics([
			{ ...zeroMetrics(), redactions: 2, verdicts: { allow: 1, block: 0, escalate: 0, redact: 1 } },
			{ ...zeroMetrics(), redactions: 4, verdicts: { allow: 2, block: 1, escalate: 1, redact: 0 } },
		]);
		expect(pooled.verdicts).toEqual({ allow: 3, block: 1, escalate: 1, redact: 1 });
		expect(pooled.redactions).toBe(6);
	});

	it("merges threat rows by control and category without duplicates", () => {
		const pooled = aggregateMetrics([
			{
				...zeroMetrics(),
				threats: [
					{
						blocked: 1,
						category: "live.probe.pii",
						controlId: "detection",
						flagged: 0,
						redacted: 2,
					},
					{
						blocked: 0,
						category: "live.probe.pii",
						controlId: "detection",
						flagged: 1,
						redacted: 1,
					},
				],
			},
			{
				...zeroMetrics(),
				threats: [
					{
						blocked: 2,
						category: "live.probe.pii",
						controlId: "detection",
						flagged: 0,
						redacted: 0,
					},
				],
			},
		]);
		expect(pooled.threats).toEqual([
			{ blocked: 3, category: "live.probe.pii", controlId: "detection", flagged: 1, redacted: 3 },
		]);
	});

	it("sorts merged threat rows by blocked count descending", () => {
		const pooled = aggregateMetrics([
			{
				...zeroMetrics(),
				threats: [
					{ blocked: 1, category: "b", controlId: "detection", flagged: 0, redacted: 0 },
					{ blocked: 5, category: "a", controlId: "signatures", flagged: 0, redacted: 0 },
				],
			},
		]);
		expect(pooled.threats.map((row) => row.blocked)).toEqual([5, 1]);
	});

	it("takes the worst latency percentile per bucket", () => {
		const pooled = aggregateMetrics([
			{ ...zeroMetrics(), latency: { p50: 30, p95: 70, p99: 70 } },
			{ ...zeroMetrics(), latency: { p50: 60, p95: 40, p99: 90 } },
		]);
		expect(pooled.latency).toEqual({ p50: 60, p95: 70, p99: 90 });
	});

	it("concatenates budget rules and merges the hourly series by timestamp", () => {
		const pooled = aggregateMetrics([
			{
				...zeroMetrics(),
				budget: [
					{
						consumerKey: "hr",
						limit: 50,
						metric: "requests",
						modelScope: "*",
						period: "day",
						used: 4,
					},
				],
				budgetSeries: [{ at: "2026-10-04T10:00:00.000Z", costUsd: 0.05, tokens: 120 }],
			},
			{
				...zeroMetrics(),
				budgetSeries: [
					{ at: "2026-10-04T10:00:00.000Z", costUsd: 0.02, tokens: 20 },
					{ at: "2026-10-04T11:00:00.000Z", costUsd: 0, tokens: 0 },
				],
			},
		]);
		expect(pooled.budget).toHaveLength(1);
		expect(pooled.budgetSeries).toEqual([
			{ at: "2026-10-04T10:00:00.000Z", costUsd: 0.07, tokens: 140 },
			{ at: "2026-10-04T11:00:00.000Z", costUsd: 0, tokens: 0 },
		]);
	});
});

describe("buildDashboardData with an empty sink", () => {
	it("produces the policy.json consumer keys, sorted", () => {
		expect(EMPTY.consumerKeys).toEqual(["hr", "manager", "software-developer"]);
		expect(Object.keys(EMPTY.byConsumer).sort()).toEqual(["hr", "manager", "software-developer"]);
	});

	it("reports zeros and empty rows for every consumer", () => {
		for (const key of EMPTY.consumerKeys) {
			expect(metricsFor(EMPTY, key)).toEqual(zeroMetrics());
		}
	});

	it("pools the aggregate to zeros", () => {
		expect(EMPTY.aggregate).toEqual(zeroMetrics());
	});

	it("leaves the escalation queue and person roster empty", () => {
		expect(EMPTY.escalations).toEqual([]);
		expect(EMPTY.personRoles).toEqual({});
	});

	it("defaults the feed version to unavailable and passes versions through", () => {
		expect(EMPTY.feedVersion).toBe("unavailable");
		expect(EMPTY.policyVersion).toBe(TEST_POLICY_VERSION);
		expect(EMPTY.generatedAt).toBe(GENERATED_AT);
	});

	it("carries the caller-supplied feed version", () => {
		const data = buildDashboardData(SNAPSHOT, GENERATED_AT, [], {
			feedVersion: TEST_FEED_VERSION,
		});
		expect(data.feedVersion).toBe(TEST_FEED_VERSION);
	});

	it("defaults the semantic version to unavailable and passes it through", () => {
		expect(EMPTY.semanticVersion).toBe("unavailable");
		const data = buildDashboardData(SNAPSHOT, GENERATED_AT, [], {
			feedVersion: TEST_FEED_VERSION,
			semanticVersion: "sem.test.live-1",
		});
		expect(data.semanticVersion).toBe("sem.test.live-1");
		expect(data.feedVersion).toBe(TEST_FEED_VERSION);
	});

	it("projects the policy view over the sample policy", () => {
		expect(EMPTY.policy.defaultProfile).toBe("standard");
		expect(EMPTY.policy.failureVerdict).toBe("escalate");
		expect(EMPTY.policy.consumers).toEqual({
			hr: "strict",
			manager: "standard",
			"software-developer": "standard",
		});
		expect(EMPTY.policy.controls.map((control) => control.id)).toEqual([
			"shape",
			"allowlist",
			"detection",
			"redaction",
			"semantic",
			"signatures",
			"budget",
		]);
		expect(EMPTY.policy.profiles.map((profile) => profile.name)).toEqual([
			"permissive",
			"standard",
			"strict",
		]);
		expect(EMPTY.policy.profiles[0]?.blockThresholds.detection.inbound).toBe(0.95);
	});
});

describe("buildDashboardData with seeded decisions", () => {
	it("counts verdicts per consumer, ignoring noise", () => {
		expect(metricsFor(SEEDED, "hr").verdicts).toEqual({
			allow: 1,
			block: 1,
			escalate: 1,
			redact: 1,
		});
		expect(metricsFor(SEEDED, "manager").verdicts).toEqual({
			allow: 1,
			block: 1,
			escalate: 1,
			redact: 0,
		});
		expect(metricsFor(SEEDED, "software-developer").verdicts).toEqual({
			allow: 1,
			block: 0,
			escalate: 0,
			redact: 1,
		});
	});

	it("pools verdicts and redaction totals into the aggregate", () => {
		expect(SEEDED.aggregate.verdicts).toEqual({ allow: 3, block: 2, escalate: 2, redact: 2 });
		expect(metricsFor(SEEDED, "hr").redactions).toBe(2);
		expect(metricsFor(SEEDED, "software-developer").redactions).toBe(4);
		expect(metricsFor(SEEDED, "manager").redactions).toBe(0);
		expect(SEEDED.aggregate.redactions).toBe(6);
	});

	it("groups threats by control and category from decision hits", () => {
		expect(metricsFor(SEEDED, "hr").threats).toEqual([
			{
				blocked: 1,
				category: "live.probe.injection",
				controlId: "signatures",
				flagged: 0,
				redacted: 0,
			},
			{ blocked: 1, category: "live.probe.exfil", controlId: "semantic", flagged: 0, redacted: 0 },
			{
				blocked: 0,
				category: "live.probe.injection",
				controlId: "detection",
				flagged: 1,
				redacted: 0,
			},
			{ blocked: 0, category: "live.probe.pii", controlId: "detection", flagged: 1, redacted: 1 },
		]);
	});

	it("attributes blocking verdicts to blocked and forwarding verdicts to flagged", () => {
		expect(metricsFor(SEEDED, "manager").threats).toEqual([
			{
				blocked: 1,
				category: "live.probe.injection",
				controlId: "signatures",
				flagged: 0,
				redacted: 0,
			},
			{ blocked: 1, category: "live.probe.exfil", controlId: "semantic", flagged: 0, redacted: 0 },
		]);
		expect(metricsFor(SEEDED, "software-developer").threats).toEqual([
			{ blocked: 0, category: "live.probe.pii", controlId: "detection", flagged: 1, redacted: 1 },
		]);
	});

	it("merges threat rows across consumers without duplicate control|category keys", () => {
		const keys = SEEDED.aggregate.threats.map((row) => `${row.controlId}|${row.category}`);
		expect(new Set(keys).size).toBe(SEEDED.aggregate.threats.length);
		expect(SEEDED.aggregate.threats).toEqual([
			{
				blocked: 2,
				category: "live.probe.injection",
				controlId: "signatures",
				flagged: 0,
				redacted: 0,
			},
			{ blocked: 2, category: "live.probe.exfil", controlId: "semantic", flagged: 0, redacted: 0 },
			{
				blocked: 0,
				category: "live.probe.injection",
				controlId: "detection",
				flagged: 1,
				redacted: 0,
			},
			{ blocked: 0, category: "live.probe.pii", controlId: "detection", flagged: 2, redacted: 2 },
		]);
	});

	it("computes per-consumer latency percentiles from latencyMs samples", () => {
		expect(metricsFor(SEEDED, "hr").latency).toEqual({ p50: 30, p95: 70, p99: 70 });
		expect(metricsFor(SEEDED, "manager").latency).toEqual({ p50: 60, p95: 90, p99: 90 });
		expect(metricsFor(SEEDED, "software-developer").latency).toEqual({
			p50: 40,
			p95: 100,
			p99: 100,
		});
	});

	it("pools the aggregate latency over every sample", () => {
		expect(SEEDED.aggregate.latency).toEqual({ p50: 50, p95: 100, p99: 100 });
	});

	it("aggregates budget used from real decisions against the policy rules", () => {
		expect(metricsFor(SEEDED, "hr").budget).toEqual([
			{ consumerKey: "hr", limit: 50, metric: "requests", modelScope: "*", period: "day", used: 4 },
			{
				consumerKey: "hr",
				limit: 1000,
				metric: "tokens",
				modelScope: "*",
				period: "day",
				used: 410,
			},
			{
				consumerKey: "hr",
				limit: 5,
				metric: "costUsd",
				modelScope: "*",
				period: "month",
				used: 0.16,
			},
		]);
	});

	it("scopes named-model rules to matching decisions only", () => {
		expect(metricsFor(SEEDED, "manager").budget).toEqual([
			{
				consumerKey: "manager",
				limit: 50,
				metric: "requests",
				modelScope: "primary",
				period: "day",
				used: 0,
			},
			{
				consumerKey: "manager",
				limit: 10_000,
				metric: "computeTimeMs",
				modelScope: "*",
				period: "day",
				used: 170,
			},
		]);
		expect(metricsFor(SEEDED, "software-developer").budget).toEqual([]);
		expect(SEEDED.aggregate.budget).toHaveLength(5);
	});

	it("buckets the hourly cost/token series from real usage", () => {
		expect(metricsFor(SEEDED, "hr").budgetSeries).toEqual([
			{ at: "2026-10-04T10:00:00.000Z", costUsd: 0.15, tokens: 360 },
			{ at: "2026-10-04T11:00:00.000Z", costUsd: 0, tokens: 0 },
			{ at: "2026-10-04T12:00:00.000Z", costUsd: 0.01, tokens: 50 },
		]);
	});

	it("leaves the series empty when no usage is recorded", () => {
		expect(metricsFor(SEEDED, "manager").budgetSeries).toEqual([
			{ at: "2026-10-04T10:00:00.000Z", costUsd: 0.02, tokens: 20 },
			{ at: "2026-10-04T11:00:00.000Z", costUsd: 0, tokens: 0 },
			{ at: "2026-10-04T13:00:00.000Z", costUsd: 0, tokens: 0 },
		]);
		expect(metricsFor(SEEDED, "software-developer").budgetSeries).toEqual([]);
	});

	it("derives the escalation queue newest first with real direction, seam, and reason", () => {
		expect(SEEDED.escalations).toEqual([
			{
				consumerKey: "manager",
				direction: "inbound",
				id: "manager-esc-1",
				reason: "manager queue needs review",
				seam: "mcp-tool",
				subject: "manager",
				timestamp: "2026-10-04T13:30:00.000Z",
			},
			{
				consumerKey: "hr",
				direction: "outbound",
				id: "hr-esc-1",
				reason: "hr queue needs review",
				seam: "chat",
				subject: "hr",
				timestamp: "2026-10-04T12:00:00.000Z",
			},
		]);
	});

	it("maps each person to their last decision's group", () => {
		expect(SEEDED.personRoles).toEqual({
			alice: "hr",
			bob: "manager",
			carol: "software-developer",
		});
	});
});

describe("selectMetrics", () => {
	it("returns the pooled aggregate for ALL_CONSUMERS", () => {
		expect(selectMetrics(SEEDED, ALL_CONSUMERS)).toBe(SEEDED.aggregate);
	});

	it("returns the consumer's own metrics otherwise", () => {
		const hr = selectMetrics(SEEDED, "hr");
		expect(SEEDED.byConsumer).toMatchObject({ hr });
		expect(hr.verdicts).toEqual({ allow: 1, block: 1, escalate: 1, redact: 1 });
		expect(selectMetrics(SEEDED, "software-developer").verdicts.redact).toBe(1);
	});

	it("falls back to the aggregate for unknown consumer keys", () => {
		expect(selectMetrics(SEEDED, "no-such-consumer")).toBe(SEEDED.aggregate);
	});
});

describe("selectEscalations", () => {
	it("returns every row for ALL_CONSUMERS", () => {
		expect(selectEscalations(SEEDED, ALL_CONSUMERS)).toEqual(SEEDED.escalations);
		expect(selectEscalations(SEEDED, ALL_CONSUMERS)).toHaveLength(2);
	});

	it("filters rows by consumer key", () => {
		expect(selectEscalations(SEEDED, "hr").map((row) => row.id)).toEqual(["hr-esc-1"]);
		expect(selectEscalations(SEEDED, "manager").map((row) => row.id)).toEqual(["manager-esc-1"]);
		expect(selectEscalations(SEEDED, "software-developer")).toEqual([]);
		for (const row of selectEscalations(SEEDED, "hr")) {
			expect(row.consumerKey).toBe("hr");
		}
	});

	it("returns no rows for unknown consumer keys", () => {
		expect(selectEscalations(SEEDED, "no-such-consumer")).toEqual([]);
	});
});

describe("personRoles", () => {
	it("is empty when no audit events are recorded", () => {
		expect(EMPTY.personRoles).toEqual({});
		expect(buildDashboardData(SNAPSHOT, GENERATED_AT, []).personRoles).toEqual({});
	});

	function personDecision(input: {
		readonly groupId?: string;
		readonly kind?: AuditEvent["kind"];
		readonly timestamp: string;
		readonly userId?: string;
		readonly verdict?: AuditEvent["verdict"];
	}): AuditEvent {
		const { kind, timestamp, ...fields } = input;
		return { ...auditEvent(kind ?? "interaction", { ...fields }), timestamp };
	}

	it("maps each person to their last decision's group", () => {
		const events: readonly AuditEvent[] = [
			personDecision({
				groupId: "hr",
				timestamp: "2026-10-04T12:00:00.000Z",
				userId: "alice",
				verdict: "allow",
			}),
			personDecision({
				groupId: "manager",
				timestamp: "2026-10-04T13:00:00.000Z",
				userId: "bob",
				verdict: "block",
			}),
			personDecision({
				groupId: "manager",
				timestamp: "2026-10-04T14:00:00.000Z",
				userId: "alice",
				verdict: "redact",
			}),
		];
		expect(buildDashboardData(SNAPSHOT, GENERATED_AT, events).personRoles).toEqual({
			alice: "manager",
			bob: "manager",
		});
	});

	it("skips non-decisions and decisions missing userId or groupId", () => {
		const events: readonly AuditEvent[] = [
			personDecision({
				groupId: "hr",
				timestamp: "2026-10-04T12:00:00.000Z",
				verdict: "allow",
			}),
			personDecision({
				timestamp: "2026-10-04T13:00:00.000Z",
				userId: "alice",
				verdict: "allow",
			}),
			personDecision({
				groupId: "hr",
				timestamp: "2026-10-04T14:00:00.000Z",
				userId: "bob",
			}),
			personDecision({
				groupId: "hr",
				kind: "registration",
				timestamp: "2026-10-04T15:00:00.000Z",
				userId: "carol",
				verdict: "allow",
			}),
			personDecision({
				groupId: "hr",
				timestamp: "2026-10-04T16:00:00.000Z",
				userId: "alice",
				verdict: "allow",
			}),
		];
		expect(buildDashboardData(SNAPSHOT, GENERATED_AT, events).personRoles).toEqual({
			alice: "hr",
		});
	});
});

describe("format helpers", () => {
	it("formats counts, currency, and token totals", () => {
		expect(formatCount(1234)).toBe("1,234");
		expect(formatUsd(9.99)).toBe("$9.99");
		expect(formatTokens(97_600)).toBe("97.6k");
		expect(formatTokens(512)).toBe("512");
	});

	it("formats latency and timestamps", () => {
		expect(formatMs(38)).toBe("38 ms");
		expect(formatTimestamp("2026-10-04T18:42:11.000Z")).toBe("2026-10-04 18:42:11Z");
		expect(formatTimeLabel("2026-10-04T18:42:11.000Z")).toBe("18:42");
	});

	it("computes clamped usage percentages", () => {
		expect(usagePercent(97_600, 200_000)).toBe(49);
		expect(usagePercent(9.99, 20)).toBe(50);
		expect(usagePercent(300, 200)).toBe(100);
		expect(usagePercent(1, 0)).toBe(0);
	});
});
