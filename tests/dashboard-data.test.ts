/**
 * Dashboard data assembly tests (saif 11.1 fixture determinism): aggregate
 * pooling, per-consumer selection, escalation filtering, and the
 * policy-projection merge in `src/dashboard/data.ts` against the real
 * `policy.json` sample.
 */
import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import type { PolicySnapshot } from "#/control/policy/loader.ts";
import { parsePolicy } from "#/control/policy/schema.ts";
import {
	aggregateMetrics,
	buildDashboardData,
	selectEscalations,
	selectMetrics,
} from "#/dashboard/data.ts";
import {
	FIXTURE_ESCALATIONS,
	FIXTURE_FEED_VERSION,
	fixtureConsumerMetrics,
} from "#/dashboard/fixture.ts";
import {
	formatCount,
	formatTimeLabel,
	formatTimestamp,
	formatTokens,
	formatUsd,
	usagePercent,
} from "#/dashboard/format.ts";
import { ALL_CONSUMERS, type ConsumerMetrics } from "#/dashboard/types.ts";

const CONSUMER_KEYS = ["hr", "manager", "software-developer"] as const;
const GENERATED_AT = "2026-10-03T20:00:00.000Z";
const TEST_POLICY_VERSION = "sha256.test-policy-version";

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
const DATA = buildDashboardData(SNAPSHOT, GENERATED_AT);
const METRICS = fixtureConsumerMetrics(CONSUMER_KEYS);

function metricsFor(key: string): ConsumerMetrics {
	const metrics = METRICS[key];
	if (metrics === undefined) {
		throw new Error(`missing fixture metrics for ${key}`);
	}
	return metrics;
}

const PARTS: readonly ConsumerMetrics[] = CONSUMER_KEYS.map((key) => metricsFor(key));

describe("aggregateMetrics", () => {
	const pooled = aggregateMetrics(PARTS);

	it("sums verdicts and redactions across consumers", () => {
		expect(pooled.verdicts).toEqual({ allow: 4270, block: 85, escalate: 13, redact: 157 });
		expect(pooled.redactions).toBe(157);
	});

	it("starts from the documented per-consumer fixture verdicts", () => {
		expect(metricsFor("hr").verdicts).toEqual({
			allow: 1180,
			block: 18,
			escalate: 3,
			redact: 42,
		});
		expect(metricsFor("manager").verdicts).toEqual({
			allow: 640,
			block: 6,
			escalate: 1,
			redact: 27,
		});
		expect(metricsFor("software-developer").verdicts).toEqual({
			allow: 2450,
			block: 61,
			escalate: 9,
			redact: 88,
		});
	});

	it("merges threat rows by control and category without duplicates", () => {
		const keys = pooled.threats.map((row) => `${row.controlId}|${row.category}`);
		expect(new Set(keys).size).toBe(pooled.threats.length);
		expect(pooled.threats.length).toBe(8);

		const piiEmail = pooled.threats.find(
			(row) => row.controlId === "detection" && row.category === "pii.email",
		);
		expect(piiEmail).toEqual({
			blocked: 4,
			category: "pii.email",
			controlId: "detection",
			flagged: 1,
			redacted: 31,
		});

		const jailbreak = pooled.threats.find(
			(row) => row.controlId === "semantic" && row.category === "jailbreak",
		);
		expect(jailbreak).toEqual({
			blocked: 10,
			category: "jailbreak",
			controlId: "semantic",
			flagged: 2,
			redacted: 7,
		});
	});

	it("sorts merged threat rows by blocked count descending", () => {
		const blocked = pooled.threats.map((row) => row.blocked);
		expect([...blocked].sort((left, right) => right - left)).toEqual(blocked);
		expect(blocked[0]).toBe(29);
		expect(pooled.threats[0]).toMatchObject({
			category: "prompt_injection",
			controlId: "signatures",
		});
	});

	it("takes the worst latency percentile per bucket", () => {
		expect(pooled.latency).toEqual({ p50: 44, p95: 140, p99: 305 });
	});

	it("concatenates budget rules and merges the hourly series by timestamp", () => {
		expect(pooled.budget.length).toBe(4);
		expect(pooled.budgetSeries.length).toBe(12);
		expect(pooled.budgetSeries[0]).toEqual({
			at: "2026-10-03T12:00:00.000Z",
			costUsd: 4.9,
			tokens: 25_200,
		});
		const times = pooled.budgetSeries.map((point) => point.at);
		expect([...times].sort((left, right) => left.localeCompare(right))).toEqual(times);
	});
});

describe("selectMetrics", () => {
	it("returns the pooled aggregate for ALL_CONSUMERS", () => {
		expect(selectMetrics(DATA, ALL_CONSUMERS)).toBe(DATA.aggregate);
	});

	it("returns the consumer's own metrics otherwise", () => {
		const hr = selectMetrics(DATA, "hr");
		expect(DATA.byConsumer).toMatchObject({ hr });
		expect(hr.verdicts).toEqual({ allow: 1180, block: 18, escalate: 3, redact: 42 });
		expect(selectMetrics(DATA, "software-developer").verdicts.allow).toBe(2450);
	});

	it("falls back to the aggregate for unknown consumer keys", () => {
		expect(selectMetrics(DATA, "no-such-consumer")).toBe(DATA.aggregate);
	});
});

describe("selectEscalations", () => {
	it("returns every row for ALL_CONSUMERS", () => {
		expect(selectEscalations(DATA, ALL_CONSUMERS)).toEqual(FIXTURE_ESCALATIONS);
		expect(selectEscalations(DATA, ALL_CONSUMERS).length).toBe(4);
	});

	it("filters rows by consumer key", () => {
		const deployBot = selectEscalations(DATA, "software-developer");
		expect(deployBot.map((row) => row.id)).toEqual(["esc-2026-10-03-014", "esc-2026-10-03-011"]);
		expect(selectEscalations(DATA, "hr").map((row) => row.id)).toEqual(["esc-2026-10-03-013"]);
		expect(selectEscalations(DATA, "manager").map((row) => row.id)).toEqual(["esc-2026-10-03-009"]);
		for (const row of deployBot) {
			expect(row.consumerKey).toBe("software-developer");
		}
	});

	it("returns no rows for unknown consumer keys", () => {
		expect(selectEscalations(DATA, "no-such-consumer")).toEqual([]);
	});
});

describe("buildDashboardData", () => {
	it("produces the policy.json consumer keys, sorted", () => {
		expect(DATA.consumerKeys).toEqual(["hr", "manager", "software-developer"]);
		expect(Object.keys(DATA.byConsumer).sort()).toEqual(["hr", "manager", "software-developer"]);
	});

	it("stamps the policy version string and fixture feed version", () => {
		expect(DATA.policyVersion).toBe(TEST_POLICY_VERSION);
		expect(DATA.policyVersion).toBeString();
		expect(DATA.feedVersion).toBe(FIXTURE_FEED_VERSION);
		expect(DATA.generatedAt).toBe(GENERATED_AT);
	});

	it("projects the policy view over the sample policy", () => {
		expect(DATA.policy.defaultProfile).toBe("standard");
		expect(DATA.policy.failureVerdict).toBe("escalate");
		expect(DATA.policy.consumers).toEqual({
			hr: "strict",
			manager: "standard",
			"software-developer": "standard",
		});
		expect(DATA.policy.controls.map((control) => control.id)).toEqual([
			"shape",
			"allowlist",
			"detection",
			"redaction",
			"semantic",
			"signatures",
			"budget",
		]);
		expect(DATA.policy.profiles.map((profile) => profile.name)).toEqual([
			"permissive",
			"standard",
			"strict",
		]);
		expect(DATA.policy.profiles[0]?.blockThresholds.detection.inbound).toBe(0.95);
	});

	it("carries fixture escalations and per-consumer metrics", () => {
		expect(DATA.escalations).toEqual(FIXTURE_ESCALATIONS);
		for (const key of DATA.consumerKeys) {
			const metrics = DATA.byConsumer[key];
			expect(metrics).toBeDefined();
			expect(metrics?.budgetSeries.length).toBe(12);
		}
		expect(DATA.aggregate.verdicts).toEqual({
			allow: 4270,
			block: 85,
			escalate: 13,
			redact: 157,
		});
	});
});

describe("format helpers", () => {
	it("formats counts, currency, and token totals", () => {
		expect(formatCount(1180)).toBe("1,180");
		expect(formatUsd(11.4)).toBe("$11.40");
		expect(formatTokens(148_200)).toBe("148.2k");
		expect(formatTokens(640)).toBe("640");
	});

	it("formats latency and timestamps", () => {
		expect(formatCount(121)).toBe("121");
		expect(formatTimestamp("2026-10-03T18:42:11.000Z")).toBe("2026-10-03 18:42:11Z");
		expect(formatTimeLabel("2026-10-03T18:42:11.000Z")).toBe("18:42");
	});

	it("computes clamped usage percentages", () => {
		expect(usagePercent(148_200, 250_000)).toBe(59);
		expect(usagePercent(11.4, 20)).toBe(57);
		expect(usagePercent(300, 200)).toBe(100);
		expect(usagePercent(1, 0)).toBe(0);
	});
});
