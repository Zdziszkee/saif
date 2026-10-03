import { z } from "zod";

/**
 * Policy document schema for the AI control layer.
 *
 * The policy file is the single source of truth for every control: which
 * controls run, how evidence maps to verdicts, which models are allowed, and
 * what budgets apply. Strictness profiles (permissive / standard / strict)
 * hold partial overrides that are deep-merged over the base `controls`.
 */

export const verdictSchema = z.enum(["allow", "redact", "block", "escalate"]);
export type Verdict = z.infer<typeof verdictSchema>;

export const directionSchema = z.enum(["input", "output"]);
export type Direction = z.infer<typeof directionSchema>;

const probability = z.number().min(0).max(1);

/** Severity rubric spans 0 (no concern) to 4 (clear and damaging attack). */
const SEVERITY_SCORE_MAX = 4;

const questionThresholdsSchema = z.object({
	/** P(true) at or above this contributes a `block` verdict. */
	blockThreshold: probability,
	enabled: z.boolean(),
	/** P(true) at or above this (below block) contributes an `escalate` verdict. */
	escalateThreshold: probability,
});
export type QuestionThresholds = z.infer<typeof questionThresholdsSchema>;

const semanticQuestionIds = [
	"promptInjection",
	"jailbreak",
	"dataExfiltration",
	"maliciousCode",
] as const;
export type SemanticQuestionId = (typeof semanticQuestionIds)[number];

const semanticControlSchema = z.object({
	/** Classifier implementation: hosted Jev, local Ollama fallback, or mock. */
	classifier: z.enum(["jev", "ollama", "mock"]),
	enabled: z.boolean(),
	/** Verdict applied when the classifier errors or times out. */
	failureVerdict: verdictSchema,
	/** Optional per-question instruction overrides (judge tunability). */
	questionOverrides: z
		.record(z.enum(semanticQuestionIds), z.object({ instructions: z.string().min(1) }))
		.optional(),
	questions: z.record(z.enum(semanticQuestionIds), questionThresholdsSchema),
	severity: z.object({
		/** Score (0-4 scale) at or above this contributes `block`. */
		blockAt: z.number().min(0).max(SEVERITY_SCORE_MAX),
		enabled: z.boolean(),
		/** Score at or above this (below block) contributes `escalate`. */
		escalateAt: z.number().min(0).max(SEVERITY_SCORE_MAX),
	}),
	threatCategory: z.object({
		/** Categories that block when selected with sufficient confidence/probability. */
		blockCategories: z.array(z.string()),
		confidenceFloor: probability,
		enabled: z.boolean(),
		probabilityFloor: probability,
	}),
	timeoutMs: z.number().int().positive(),
	/** Verdict applied when an answer falls below its confidence/probability floors. */
	uncertaintyVerdict: verdictSchema,
});
export type SemanticControl = z.infer<typeof semanticControlSchema>;

const deterministicControlSchema = z.object({
	actions: z.object({
		pii: verdictSchema,
		secret: verdictSchema,
	}),
	enabled: z.boolean(),
});
export type DeterministicControl = z.infer<typeof deterministicControlSchema>;

const severityLevels = ["low", "medium", "high", "critical"] as const;
export type SignatureSeverity = (typeof severityLevels)[number];

const signatureControlSchema = z.object({
	actions: z.object({
		bySeverity: z.record(z.enum(severityLevels), verdictSchema),
		/** Applied when a severity has no explicit mapping. */
		default: verdictSchema,
	}),
	enabled: z.boolean(),
});
export type SignatureControl = z.infer<typeof signatureControlSchema>;

const budgetWindowSchema = z.enum(["hour", "day", "month"]);
export type BudgetWindow = z.infer<typeof budgetWindowSchema>;

const budgetRuleSchema = z.object({
	budgetGroup: z.string().min(1),
	id: z.string().min(1),
	/** Max compute time in ms per window (local model usage). */
	limitComputeMs: z.number().int().nonnegative(),
	/** Max request count per window. */
	limitRequests: z.number().int().nonnegative(),
	/** Max tokens per window (downstream + semantic usage). */
	limitTokens: z.number().int().nonnegative(),
	/** Max spend in USD per window. */
	limitUsd: z.number().nonnegative(),
	overBudgetVerdict: verdictSchema,
	window: budgetWindowSchema,
});
export type BudgetRule = z.infer<typeof budgetRuleSchema>;

const budgetsControlSchema = z.object({
	enabled: z.boolean(),
	rules: z.array(budgetRuleSchema),
});
export type BudgetsControl = z.infer<typeof budgetsControlSchema>;

const controlsSchema = z.object({
	budgets: budgetsControlSchema,
	deterministic: deterministicControlSchema,
	semantic: semanticControlSchema,
	signatures: signatureControlSchema,
});
export type Controls = z.infer<typeof controlsSchema>;

/** Partial overrides a strictness profile applies over the base controls. */
const controlsOverrideSchema = z.object({
	budgets: budgetsControlSchema.partial().optional(),
	deterministic: deterministicControlSchema.partial().optional(),
	semantic: semanticControlSchema
		.partial()
		.omit({ questionOverrides: true, questions: true, severity: true, threatCategory: true })
		.extend({
			questions: z
				.record(z.enum(semanticQuestionIds), questionThresholdsSchema.partial())
				.optional(),
			severity: semanticControlSchema.shape.severity.partial().optional(),
			threatCategory: semanticControlSchema.shape.threatCategory.partial().optional(),
		})
		.optional(),
	signatures: signatureControlSchema
		.partial()
		.extend({ actions: signatureControlSchema.shape.actions.partial().optional() })
		.optional(),
});
export type ControlsOverride = z.infer<typeof controlsOverrideSchema>;

const profileSchema = z.object({
	controls: controlsOverrideSchema.optional(),
	failureVerdict: verdictSchema.optional(),
});
export type ProfileOverride = z.infer<typeof profileSchema>;

export const profileNames = ["permissive", "standard", "strict"] as const;
export type ProfileName = (typeof profileNames)[number];

export const policySchema = z.object({
	allowlist: z.object({
		/** Allowed model ids; `*` allows any. */
		models: z.array(z.string().min(1)).min(1),
	}),
	consumers: z.record(
		z.string(),
		z.object({ budgetGroup: z.string().min(1), profile: z.enum(profileNames) }),
	),
	controls: controlsSchema,
	defaultProfile: z.enum(profileNames),
	/** Master switch: false runs the pipeline in observe-only (audit, no enforcement). */
	enabled: z.boolean(),
	failureVerdict: verdictSchema,
	profiles: z.object({
		permissive: profileSchema,
		standard: profileSchema,
		strict: profileSchema,
	}),
	version: z.number().int().nonnegative(),
});
export type Policy = z.infer<typeof policySchema>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursive merge; the override wins. Arrays are replaced, not merged. */
export function deepMerge<T>(base: T, override: unknown): T {
	if (!(isPlainObject(base) && isPlainObject(override))) {
		return (override === undefined ? base : override) as T;
	}
	const out: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		out[key] = value === undefined ? out[key] : deepMerge(out[key], value);
	}
	return out as T;
}

export interface ResolvedControls {
	controls: Controls;
	failureVerdict: Verdict;
}

/** Resolve the effective controls for a strictness profile. */
export function resolveProfile(policy: Policy, profile: ProfileName): ResolvedControls {
	const override: ProfileOverride = policy.profiles[profile];
	return {
		controls: deepMerge(policy.controls, override.controls ?? {}),
		failureVerdict: override.failureVerdict ?? policy.failureVerdict,
	};
}

/** Resolve the effective controls for a consumer key (falls back to defaultProfile). */
export function resolveConsumer(
	policy: Policy,
	consumerKey: string,
): { profile: ProfileName; budgetGroup: string; resolved: ResolvedControls } {
	const consumer = policy.consumers[consumerKey];
	const profile = consumer?.profile ?? policy.defaultProfile;
	return {
		budgetGroup: consumer?.budgetGroup ?? "default",
		profile,
		resolved: resolveProfile(policy, profile),
	};
}

/** Models are allowlisted when the list contains `*` or the exact model id. */
export function isModelAllowed(policy: Policy, model: string): boolean {
	return policy.allowlist.models.includes("*") || policy.allowlist.models.includes(model);
}
