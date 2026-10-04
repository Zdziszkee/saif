/**
 * In-memory budget enforcement (tasks 7.1-7.3).
 *
 * Pure reservation ledger over the policy budget rules: estimate a call's
 * token weight before the model runs, reserve it against the consumer's
 * window bucket, then settle with the measured usage once the call
 * completes. The clock is always injected (`nowMs`) so window rollover is
 * testable without timers, and there is no backing table — the deliberate
 * `budget_windows` omission in `docs/storage.md` stands, and `src/db/*` is
 * owned elsewhere, so this module stays dependency-free (durable settlement
 * composes later by calling `reserve`/`settle` around commits).
 */

import type { z } from "zod";
import type { budgetRuleSchema } from "./policy/schema.ts";

export type BudgetRule = z.infer<typeof budgetRuleSchema>;

/** Window a budget rule accrues in; mirrors the policy schema's `period`. */
export type BudgetPeriod = BudgetRule["period"];

/** Dimensions a budget rule can limit; one rule needs at least one. */
export type BudgetMetric = "computeTimeMs" | "costUsd" | "requests" | "tokens";

/** Measured or estimated spend in one window bucket. */
export interface BudgetUsage {
	computeTimeMs: number;
	costUsd: number;
	requests: number;
	tokens: number;
}

/** Outcome of a budget check: the first breached rule wins. */
export interface BudgetCheck {
	overBudget: boolean;
	rule?: BudgetRule | undefined;
}

/** One rule's spend against its limit, for per-key reporting. */
export interface BudgetRuleStatus {
	consumerKey: string;
	limit: number;
	metric: BudgetMetric;
	modelScope: string;
	overBudget: boolean;
	period: BudgetPeriod;
	ruleKey: string;
	used: number;
}

/** Characters assumed per token by `estimateTokens` (see its docs). */
const CHARS_PER_TOKEN = 4;
/** Fixed window length; day/month windows use UTC calendar math instead. */
const HOUR_MS = 3_600_000;
/** Every metric a rule can limit, for status reporting. */
const BUDGET_METRICS: readonly BudgetMetric[] = ["computeTimeMs", "costUsd", "requests", "tokens"];

const EMPTY_USAGE: BudgetUsage = { computeTimeMs: 0, costUsd: 0, requests: 0, tokens: 0 };

/** One settlement: measured actuals plus the estimate they reconcile against. */
export interface BudgetSettlement {
	actual: Partial<BudgetUsage>;
	consumer: string;
	estimate?: Partial<BudgetUsage> | undefined;
	nowMs: number;
	period: BudgetPeriod;
}

/**
 * Rough pre-call token estimate: `ceil(chars / 4)`.
 *
 * Heuristic for English prose under a GPT-style BPE tokenizer; CJK text,
 * code, and whitespace-heavy input tokenize denser or sparser, so this is
 * only ever a reservation weight — `settle` replaces it with measured
 * usage once the call completes. Counts UTF-16 code units.
 */
export function estimateTokens(content: string): number {
	return Math.ceil(content.length / CHARS_PER_TOKEN);
}

/**
 * Start of the window containing `nowMs`, in epoch milliseconds (UTC).
 * Hours floor to the clock hour; days to UTC midnight; months to the first
 * of the UTC month. Pure calendar math — no cron, no stored windows.
 */
export function bucketStart(period: BudgetPeriod, nowMs: number): number {
	if (period === "hour") {
		return Math.floor(nowMs / HOUR_MS) * HOUR_MS;
	}
	const at = new Date(nowMs);
	if (period === "day") {
		return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
	}
	return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
}

/** Window bucket label a ledger key hangs off: `period|bucketStartMs`. */
export function budgetWindowBucket(period: BudgetPeriod, nowMs: number): string {
	return `${period}|${bucketStart(period, nowMs)}`;
}

/** Ledger key for one consumer's bucket: `consumer|windowBucket`. */
export function ledgerKey(consumer: string, windowBucket: string): string {
	return `${consumer}|${windowBucket}`;
}

/** True when `usage` meets or exceeds any limit the rule sets. */
export function ruleExceeded(rule: BudgetRule, usage: BudgetUsage): boolean {
	return (
		(rule.computeTimeMs !== undefined && usage.computeTimeMs >= rule.computeTimeMs) ||
		(rule.costUsd !== undefined && usage.costUsd >= rule.costUsd) ||
		(rule.requests !== undefined && usage.requests >= rule.requests) ||
		(rule.tokens !== undefined && usage.tokens >= rule.tokens)
	);
}

/** First breached rule wins; a clean sweep allows with no attribution. */
export function checkBudgetRules(rules: readonly BudgetRule[], usage: BudgetUsage): BudgetCheck {
	const rule = rules.find((candidate) => ruleExceeded(candidate, usage));
	if (rule === undefined) {
		return { overBudget: false };
	}
	return { overBudget: true, rule };
}

/**
 * Whether a rule meters a call: `*` covers every model, otherwise the call's
 * model must match exactly. A model-less call only matches `*` rules.
 */
export function modelInScope(rule: BudgetRule, model: string | undefined): boolean {
	return rule.modelScope === "*" || (model !== undefined && rule.modelScope === model);
}

function sanitizeAmount(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value) || value <= 0) {
		return 0;
	}
	return value;
}

/** Partial estimates/actuals densified: missing, unusable, or negative is 0. */
function normalizeUsage(partial: Partial<BudgetUsage>): BudgetUsage {
	return {
		computeTimeMs: sanitizeAmount(partial.computeTimeMs),
		costUsd: sanitizeAmount(partial.costUsd),
		requests: sanitizeAmount(partial.requests),
		tokens: sanitizeAmount(partial.tokens),
	};
}

function addUsage(left: BudgetUsage, right: BudgetUsage): BudgetUsage {
	return {
		computeTimeMs: left.computeTimeMs + right.computeTimeMs,
		costUsd: left.costUsd + right.costUsd,
		requests: left.requests + right.requests,
		tokens: left.tokens + right.tokens,
	};
}

/** Subtract clamped at zero so an over-large release never goes negative. */
function releaseUsage(held: BudgetUsage, released: BudgetUsage): BudgetUsage {
	return {
		computeTimeMs: Math.max(0, held.computeTimeMs - released.computeTimeMs),
		costUsd: Math.max(0, held.costUsd - released.costUsd),
		requests: Math.max(0, held.requests - released.requests),
		tokens: Math.max(0, held.tokens - released.tokens),
	};
}

/**
 * Per-bucket spend ledger: `consumer|windowBucket` to settled plus reserved
 * usage. Reservations make in-flight calls visible to the next admission
 * check; settling releases the estimate and records the measured actuals,
 * so a cheap completion frees the over-reserved headroom.
 */
export class BudgetLedger {
	readonly #reserved = new Map<string, BudgetUsage>();
	readonly #settled = new Map<string, BudgetUsage>();

	private keyFor(consumer: string, period: BudgetPeriod, nowMs: number): string {
		return ledgerKey(consumer, budgetWindowBucket(period, nowMs));
	}

	/** Hold `estimate` against the consumer's current bucket. */
	reserve(
		consumer: string,
		period: BudgetPeriod,
		nowMs: number,
		estimate: Partial<BudgetUsage>,
	): void {
		const key = this.keyFor(consumer, period, nowMs);
		this.#reserved.set(
			key,
			addUsage(this.#reserved.get(key) ?? EMPTY_USAGE, normalizeUsage(estimate)),
		);
	}

	/**
	 * Reconcile a reservation against measured actuals: release the estimate
	 * (clamped at zero) and record the actuals. Without an `estimate` the
	 * actuals simply accumulate (post-hoc metering).
	 */
	settle(settlement: BudgetSettlement): void {
		const key = this.keyFor(settlement.consumer, settlement.period, settlement.nowMs);
		if (settlement.estimate !== undefined) {
			this.#reserved.set(
				key,
				releaseUsage(this.#reserved.get(key) ?? EMPTY_USAGE, normalizeUsage(settlement.estimate)),
			);
		}
		this.#settled.set(
			key,
			addUsage(this.#settled.get(key) ?? EMPTY_USAGE, normalizeUsage(settlement.actual)),
		);
	}

	/** Settled plus still-reserved usage in the consumer's current bucket. */
	usageFor(consumer: string, period: BudgetPeriod, nowMs: number): BudgetUsage {
		const key = this.keyFor(consumer, period, nowMs);
		return addUsage(this.#settled.get(key) ?? EMPTY_USAGE, this.#reserved.get(key) ?? EMPTY_USAGE);
	}

	/** Pure rule check over caller-supplied usage (no ledger state). */
	check(rules: readonly BudgetRule[], usage: BudgetUsage): BudgetCheck {
		return checkBudgetRules(rules, usage);
	}

	/**
	 * Window-aware admission check: each rule accrues in its own period
	 * bucket, and only rules keyed to `consumer` whose model scope covers
	 * `model` participate. The first breached rule wins.
	 */
	checkConsumer(
		consumer: string,
		model: string | undefined,
		nowMs: number,
		rules: readonly BudgetRule[],
	): BudgetCheck {
		for (const rule of rules) {
			if (rule.key !== consumer || !modelInScope(rule, model)) {
				continue;
			}
			if (ruleExceeded(rule, this.usageFor(consumer, rule.period, nowMs))) {
				return { overBudget: true, rule };
			}
		}
		return { overBudget: false };
	}

	/**
	 * Per-key spend report: one row per (matching rule, limited metric) with
	 * the bucket's used amount against the limit.
	 */
	reportConsumer(
		consumer: string,
		model: string | undefined,
		nowMs: number,
		rules: readonly BudgetRule[],
	): BudgetRuleStatus[] {
		const rows: BudgetRuleStatus[] = [];
		for (const rule of rules) {
			if (rule.key !== consumer || !modelInScope(rule, model)) {
				continue;
			}
			const usage = this.usageFor(consumer, rule.period, nowMs);
			for (const metric of BUDGET_METRICS) {
				const limit = rule[metric];
				if (limit === undefined) {
					continue;
				}
				const used = usage[metric];
				rows.push({
					consumerKey: consumer,
					limit,
					metric,
					modelScope: rule.modelScope,
					overBudget: used >= limit,
					period: rule.period,
					ruleKey: rule.key,
					used,
				});
			}
		}
		return rows;
	}
}
