import { describe, expect, it } from "bun:test";

import { type AuditEvent, auditEvent, summarizeAuditDecisions } from "#/control/audit.ts";
import { countUnpricedCalls, evaluateSpendVsLimits, type UsageRow } from "#/dashboard/data.ts";
import type { BudgetRuleView } from "#/dashboard/types.ts";

const NOW = Date.parse("2026-10-03T14:00:00.000Z");

function decision(input: {
	controlId: string;
	groupId: string;
	userId: string;
	verdict: AuditEvent["verdict"];
}): AuditEvent {
	return auditEvent("interaction", { ...input, consumerKey: input.groupId });
}

const AUDIT: readonly AuditEvent[] = [
	decision({ controlId: "deterministic", groupId: "hr", userId: "alice", verdict: "allow" }),
	decision({ controlId: "deterministic", groupId: "hr", userId: "bob", verdict: "allow" }),
	decision({ controlId: "signatures", groupId: "hr", userId: "alice", verdict: "block" }),
	decision({ controlId: "semantic", groupId: "manager", userId: "carol", verdict: "escalate" }),
	decision({ controlId: "semantic", groupId: "manager", userId: "carol", verdict: "allow" }),
];

const ROWS: readonly UsageRow[] = [
	{
		costUsd: 0.5,
		groupId: "hr",
		model: "primary",
		tokens: 1000,
		ts: new Date(NOW - 1000).toISOString(),
		userId: "alice",
	},
	{ costUsd: null, groupId: "hr", model: "primary", tokens: 500, ts: NOW - 2000, userId: "bob" },
	{ groupId: "hr", model: "primary", tokens: 200, ts: NOW - 3000, userId: "carol" },
	{
		costUsd: 0,
		groupId: "manager",
		model: "local-small",
		tokens: 100,
		ts: NOW - 4000,
		userId: "dan",
	},
	// Outside the day window: excluded from daily rules, kept for monthly ones.
	{
		costUsd: 9.99,
		groupId: "hr",
		model: "primary",
		tokens: 50,
		ts: "2026-09-01T00:00:00.000Z",
		userId: "alice",
	},
	// No timestamp: cannot be proven outside the window, so it is included.
	{ costUsd: 1, groupId: "hr", model: "primary", tokens: 10, userId: "erin" },
];

const RULES: readonly BudgetRuleView[] = [
	{ consumerKey: "hr", limit: 1200, metric: "tokens", modelScope: "*", period: "day", used: 0 },
	{
		consumerKey: "hr",
		limit: 20,
		metric: "costUsd",
		modelScope: "primary",
		period: "month",
		used: 0,
	},
	{ consumerKey: "hr", limit: 6, metric: "requests", modelScope: "*", period: "day", used: 0 },
	{
		consumerKey: "manager",
		limit: 1000,
		metric: "tokens",
		modelScope: "primary",
		period: "day",
		used: 0,
	},
];

describe("metrics over seeded audit and usage", () => {
	it("counts verdicts by check and by group", () => {
		const summary = summarizeAuditDecisions(AUDIT);
		expect(summary.total).toBe(5);
		expect(summary.byVerdict).toEqual([
			["allow", 3],
			["block", 1],
			["escalate", 1],
		]);
		expect(summary.byControl).toEqual([
			["deterministic", 2],
			["semantic", 2],
			["signatures", 1],
		]);
		expect(summary.byConsumer).toEqual([
			["hr", 3],
			["manager", 2],
		]);
	});

	it("counts unpriced calls (costUsd null or missing)", () => {
		// The null-priced and the cost-less hr rows; the known-free (0) manager row is priced.
		expect(countUnpricedCalls(ROWS)).toBe(2);
		expect(countUnpricedCalls([])).toBe(0);
	});

	it("evaluates spend against limits in each rule's own window", () => {
		const evaluated = evaluateSpendVsLimits(ROWS, RULES, NOW);
		expect(evaluated).toEqual([
			{
				consumerKey: "hr",
				limit: 1200,
				metric: "tokens",
				modelScope: "*",
				overBudget: true,
				period: "day",
				used: 1710,
			},
			{
				consumerKey: "hr",
				limit: 20,
				metric: "costUsd",
				modelScope: "primary",
				overBudget: false,
				period: "month",
				used: 1.5,
			},
			{
				consumerKey: "hr",
				limit: 6,
				metric: "requests",
				modelScope: "*",
				overBudget: false,
				period: "day",
				used: 4,
			},
			{
				consumerKey: "manager",
				limit: 1000,
				metric: "tokens",
				modelScope: "primary",
				overBudget: false,
				period: "day",
				used: 0,
			},
		]);
	});

	it("scopes rows by consumer and model", () => {
		const evaluated = evaluateSpendVsLimits(ROWS, RULES, NOW);
		// The manager row runs local-small, so the primary-scoped manager rule sees nothing.
		expect(evaluated[3]?.used).toBe(0);
		// The September row is outside the October month window for cost, inside nothing daily.
		expect(evaluated[1]?.used).toBe(1.5);
	});
});
