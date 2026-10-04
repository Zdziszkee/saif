import { describe, expect, it } from "bun:test";

import {
	BudgetLedger,
	type BudgetRule,
	bucketStart,
	checkBudgetRules,
	estimateTokens,
} from "#/control/budget.ts";
import { createControlPipeline } from "#/control/pipeline.ts";
import { resolveProfile } from "#/control/policy/apply.ts";
import { parsePolicy } from "#/control/policy/schema.ts";
import type { Control, Interaction } from "#/control/types.ts";
import policyDocument from "../policy.json" with { type: "json" };

const NOW = Date.parse("2026-10-03T14:15:00.000Z");
const HOUR_START = Date.parse("2026-10-03T14:00:00.000Z");
const DAY_START = Date.parse("2026-10-03T00:00:00.000Z");
const MONTH_START = Date.parse("2026-10-01T00:00:00.000Z");

function tokenRule(overrides: Partial<BudgetRule> = {}): BudgetRule {
	return { key: "user-1", modelScope: "*", period: "day", tokens: 100, ...overrides };
}

function shippedStandard() {
	const parsed = parsePolicy(policyDocument);
	if (!parsed.success) {
		throw new Error("shipped policy.json failed validation");
	}
	return resolveProfile(parsed.policy, "standard");
}

function allowControl(): Control {
	return {
		id: "allow",
		inspect: () => ({ verdict: "allow" }),
	};
}

function interaction(): Interaction {
	return { content: "hello", direction: "inbound", groupId: "test", id: "budget", seam: "chat" };
}

describe("estimateTokens", () => {
	it("estimates roughly four characters per token", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("abcd")).toBe(1);
		expect(estimateTokens("abcde")).toBe(2);
		expect(estimateTokens("hello world")).toBe(3);
	});
});

describe("bucketStart", () => {
	it("floors each period to its UTC window start", () => {
		expect(bucketStart("hour", NOW)).toBe(HOUR_START);
		expect(bucketStart("day", NOW)).toBe(DAY_START);
		expect(bucketStart("month", NOW)).toBe(MONTH_START);
	});

	it("holds the boundary instant in the new window", () => {
		expect(bucketStart("hour", HOUR_START)).toBe(HOUR_START);
		expect(bucketStart("day", DAY_START)).toBe(DAY_START);
		expect(bucketStart("month", MONTH_START)).toBe(MONTH_START);
	});

	it("rolls over at window boundaries", () => {
		expect(bucketStart("hour", HOUR_START - 1)).toBe(HOUR_START - 3_600_000);
		expect(bucketStart("day", DAY_START - 1)).toBe(Date.parse("2026-10-02T00:00:00.000Z"));
		expect(bucketStart("month", MONTH_START - 1)).toBe(Date.parse("2026-09-01T00:00:00.000Z"));
	});
});

describe("checkBudgetRules", () => {
	it("allows a clean sweep with no attribution", () => {
		const check = checkBudgetRules([tokenRule()], {
			computeTimeMs: 0,
			costUsd: 0,
			requests: 0,
			tokens: 10,
		});
		expect(check).toEqual({ overBudget: false });
	});

	it("blocks at (not past) the limit on every dimension", () => {
		const rules: readonly BudgetRule[] = [
			{ key: "user-1", modelScope: "*", period: "day", tokens: 100 },
			{ costUsd: 20, key: "user-1", modelScope: "*", period: "month" },
			{ key: "user-1", modelScope: "primary", period: "day", requests: 5 },
			{ computeTimeMs: 6000, key: "user-1", modelScope: "*", period: "day" },
		];
		expect(
			checkBudgetRules(rules, { computeTimeMs: 0, costUsd: 0, requests: 0, tokens: 100 })
				.overBudget,
		).toBe(true);
		expect(
			checkBudgetRules(rules, { computeTimeMs: 0, costUsd: 20, requests: 0, tokens: 0 }).overBudget,
		).toBe(true);
		expect(
			checkBudgetRules(rules, { computeTimeMs: 0, costUsd: 0, requests: 5, tokens: 0 }).overBudget,
		).toBe(true);
		expect(
			checkBudgetRules(rules, { computeTimeMs: 6000, costUsd: 0, requests: 0, tokens: 0 })
				.overBudget,
		).toBe(true);
		expect(
			checkBudgetRules(rules, { computeTimeMs: 5999, costUsd: 19, requests: 4, tokens: 99 })
				.overBudget,
		).toBe(false);
	});

	it("returns the first breached rule", () => {
		const first = tokenRule({ tokens: 10 });
		const second = tokenRule({ tokens: 50 });
		const check = checkBudgetRules([first, second], {
			computeTimeMs: 0,
			costUsd: 0,
			requests: 0,
			tokens: 60,
		});
		expect(check).toEqual({ overBudget: true, rule: first });
	});
});

describe("BudgetLedger reserve/settle", () => {
	it("reconciles settlement against the reservation", () => {
		const ledger = new BudgetLedger();
		ledger.reserve("user-1", "day", NOW, { tokens: 60 });
		expect(ledger.usageFor("user-1", "day", NOW).tokens).toBe(60);
		ledger.settle({
			actual: { tokens: 40 },
			consumer: "user-1",
			estimate: { tokens: 60 },
			nowMs: NOW,
			period: "day",
		});
		expect(ledger.usageFor("user-1", "day", NOW)).toEqual({
			computeTimeMs: 0,
			costUsd: 0,
			requests: 0,
			tokens: 40,
		});
	});

	it("accumulates post-hoc actuals without a reservation", () => {
		const ledger = new BudgetLedger();
		ledger.settle({
			actual: { costUsd: 1.5, requests: 1 },
			consumer: "user-1",
			nowMs: NOW,
			period: "day",
		});
		ledger.settle({
			actual: { costUsd: 2.5, requests: 2 },
			consumer: "user-1",
			nowMs: NOW,
			period: "day",
		});
		expect(ledger.usageFor("user-1", "day", NOW)).toEqual({
			computeTimeMs: 0,
			costUsd: 4,
			requests: 3,
			tokens: 0,
		});
	});

	it("clamps an over-large release at zero", () => {
		const ledger = new BudgetLedger();
		ledger.reserve("user-1", "day", NOW, { tokens: 10 });
		ledger.settle({
			actual: { tokens: 5 },
			consumer: "user-1",
			estimate: { tokens: 50 },
			nowMs: NOW,
			period: "day",
		});
		expect(ledger.usageFor("user-1", "day", NOW).tokens).toBe(5);
	});

	it("isolates consumers and windows", () => {
		const ledger = new BudgetLedger();
		ledger.reserve("user-1", "day", NOW, { tokens: 10 });
		expect(ledger.usageFor("user-2", "day", NOW).tokens).toBe(0);
		expect(ledger.usageFor("user-1", "hour", NOW).tokens).toBe(0);
	});
});

describe("BudgetLedger windows", () => {
	it("drops last hour's spend after rollover", () => {
		const ledger = new BudgetLedger();
		const rules: readonly BudgetRule[] = [
			{ key: "user-1", modelScope: "*", period: "hour", tokens: 100 },
		];
		ledger.settle({ actual: { tokens: 100 }, consumer: "user-1", nowMs: NOW, period: "hour" });
		expect(ledger.checkConsumer("user-1", undefined, NOW, rules).overBudget).toBe(true);
		const nextHour = NOW + 3_600_000;
		expect(ledger.usageFor("user-1", "hour", nextHour).tokens).toBe(0);
		expect(ledger.checkConsumer("user-1", undefined, nextHour, rules).overBudget).toBe(false);
	});

	it("keeps each period in its own bucket", () => {
		const ledger = new BudgetLedger();
		ledger.settle({ actual: { tokens: 100 }, consumer: "user-1", nowMs: NOW, period: "hour" });
		expect(ledger.usageFor("user-1", "day", NOW).tokens).toBe(0);
	});
});

describe("BudgetLedger per-key reporting", () => {
	const rules: readonly BudgetRule[] = [
		{ key: "user-1", modelScope: "*", period: "day", tokens: 100 },
		{ costUsd: 5, key: "user-1", modelScope: "primary", period: "month" },
		{ key: "user-2", modelScope: "*", period: "day", tokens: 10 },
	];

	it("reports only the consumer's in-scope rules", () => {
		const ledger = new BudgetLedger();
		ledger.settle({ actual: { tokens: 60 }, consumer: "user-1", nowMs: NOW, period: "day" });
		const rows = ledger.reportConsumer("user-1", "primary", NOW, rules);
		expect(rows).toEqual([
			{
				consumerKey: "user-1",
				limit: 100,
				metric: "tokens",
				modelScope: "*",
				overBudget: false,
				period: "day",
				ruleKey: "user-1",
				used: 60,
			},
			{
				consumerKey: "user-1",
				limit: 5,
				metric: "costUsd",
				modelScope: "primary",
				overBudget: false,
				period: "month",
				ruleKey: "user-1",
				used: 0,
			},
		]);
	});

	it("excludes out-of-scope models and other consumers", () => {
		const ledger = new BudgetLedger();
		expect(ledger.reportConsumer("user-1", "other-model", NOW, rules).length).toBe(1);
		expect(ledger.reportConsumer("user-2", "primary", NOW, rules).length).toBe(1);
		expect(ledger.checkConsumer("user-2", undefined, NOW, rules).overBudget).toBe(false);
	});

	it("flags breached rows in the report", () => {
		const ledger = new BudgetLedger();
		ledger.settle({ actual: { tokens: 10 }, consumer: "user-2", nowMs: NOW, period: "day" });
		const rows = ledger.reportConsumer("user-2", undefined, NOW, rules);
		expect(rows).toEqual([
			{
				consumerKey: "user-2",
				limit: 10,
				metric: "tokens",
				modelScope: "*",
				overBudget: true,
				period: "day",
				ruleKey: "user-2",
				used: 10,
			},
		]);
	});
});

describe("budget exhaustion through the pipeline", () => {
	it("blocks via checkBudget once the ledger is exhausted", async () => {
		const ledger = new BudgetLedger();
		const rules: readonly BudgetRule[] = [tokenRule({ tokens: 50 })];
		ledger.reserve("user-1", "day", NOW, { tokens: 50 });
		const pipeline = createControlPipeline({
			budgetVerdict: "block",
			checkBudget: () => ledger.checkConsumer("user-1", undefined, NOW, rules),
			controls: [allowControl()],
			profile: shippedStandard(),
		});
		const outcome = await pipeline.inspect(interaction());
		expect(outcome.verdict).toBe("block");
		expect(outcome.blockingControl).toBe("budget");
	});

	it("allows the same traffic while headroom remains", async () => {
		const ledger = new BudgetLedger();
		const rules: readonly BudgetRule[] = [tokenRule({ tokens: 50 })];
		ledger.reserve("user-1", "day", NOW, { tokens: 10 });
		const pipeline = createControlPipeline({
			checkBudget: () => ledger.checkConsumer("user-1", undefined, NOW, rules),
			controls: [allowControl()],
			profile: shippedStandard(),
		});
		expect((await pipeline.inspect(interaction())).verdict).toBe("allow");
	});

	it("defaults to allow when no probe is wired", async () => {
		const pipeline = createControlPipeline({
			controls: [allowControl()],
			profile: shippedStandard(),
		});
		expect((await pipeline.inspect(interaction())).verdict).toBe("allow");
	});
});
