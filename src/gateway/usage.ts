/**
 * Usage ledger and budget enforcement for the LLM gateway.
 *
 * Spend is attributed per user (limits) within UTC hour/day/month windows;
 * groups aggregate but never limit. Records carry `costUsd: null` when the
 * model is absent from the price table — cost dimensions skip unpriced
 * usage rather than blocking on unknown prices, while token and request
 * dimensions always enforce. Pure functions over explicit record lists;
 * the runtime holds the singleton, tests pass fixtures.
 */

import type { z } from "zod";
import type { budgetRuleSchema } from "#/control/policy/schema.ts";

export type BudgetRule = z.infer<typeof budgetRuleSchema>;

export interface UsageRecord {
	at: string;
	completionTokens: number;
	costUsd: number | null;
	groupId: string;
	model: string;
	promptTokens: number;
	userId: string;
}

export type BudgetPeriod = "day" | "hour" | "month";

/** Retention bound: older than any window the ledger can be asked about. */
const RETENTION_DAYS = 62;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const RETENTION_MS =
	RETENTION_DAYS * HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

function windowStart(now: number, period: BudgetPeriod): number {
	const date = new Date(now);
	if (period === "hour") {
		date.setUTCMinutes(0, 0, 0);
		return date.getTime();
	}
	if (period === "day") {
		date.setUTCHours(0, 0, 0, 0);
		return date.getTime();
	}
	date.setUTCDate(1);
	date.setUTCHours(0, 0, 0, 0);
	return date.getTime();
}

export interface WindowSpend {
	costKnown: boolean;
	costUsd: number;
	requests: number;
	tokens: number;
}

/** Aggregate one user's spend with one model inside a period window. */
export function windowSpend(input: {
	model: string;
	now: number;
	period: BudgetPeriod;
	records: readonly UsageRecord[];
	userId: string;
}): WindowSpend {
	const start = windowStart(input.now, input.period);
	let costKnown = true;
	let costUsd = 0;
	let requests = 0;
	let tokens = 0;
	for (const record of input.records) {
		if (record.userId !== input.userId || Date.parse(record.at) < start) {
			continue;
		}
		if (record.model !== input.model) {
			continue;
		}
		requests += 1;
		tokens += record.promptTokens + record.completionTokens;
		if (record.costUsd === null) {
			costKnown = false;
		} else {
			costUsd += record.costUsd;
		}
	}
	return { costKnown, costUsd, requests, tokens };
}

export interface BudgetBreach {
	dimension: string;
	limit: number;
	rule: BudgetRule;
	used: number;
}

function ruleApplies(rule: BudgetRule, userId: string, model: string): boolean {
	return rule.key === userId && (rule.modelScope === "*" || rule.modelScope === model);
}

/**
 * Check one user's spend against every matching rule. First breach wins;
 * compute-time rules have no measured data and are skipped with the rest
 * enforced. Unknown-cost usage never trips the cost dimension.
 */
export function checkBudget(input: {
	model: string;
	now: number;
	records: readonly UsageRecord[];
	rules: readonly BudgetRule[];
	userId: string;
}): { ok: true } | { breach: BudgetBreach; ok: false } {
	for (const rule of input.rules) {
		if (!ruleApplies(rule, input.userId, input.model)) {
			continue;
		}
		const spend = windowSpend({
			model: input.model,
			now: input.now,
			period: rule.period,
			records: input.records,
			userId: input.userId,
		});
		if (rule.tokens !== undefined && spend.tokens >= rule.tokens) {
			return {
				breach: { dimension: "tokens", limit: rule.tokens, rule, used: spend.tokens },
				ok: false,
			};
		}
		if (rule.requests !== undefined && spend.requests >= rule.requests) {
			return {
				breach: { dimension: "requests", limit: rule.requests, rule, used: spend.requests },
				ok: false,
			};
		}
		if (rule.costUsd !== undefined && spend.costKnown && spend.costUsd >= rule.costUsd) {
			return {
				breach: { dimension: "costUsd", limit: rule.costUsd, rule, used: spend.costUsd },
				ok: false,
			};
		}
	}
	return { ok: true };
}

/** In-memory record store with retention pruning on every insert. */
export class UsageLedger {
	private records: UsageRecord[] = [];

	record(entry: UsageRecord): void {
		this.records.push(entry);
		const cutoff = Date.parse(entry.at) - RETENTION_MS;
		this.records = this.records.filter((record) => Date.parse(record.at) >= cutoff);
	}

	snapshot(): readonly UsageRecord[] {
		return this.records;
	}
}
