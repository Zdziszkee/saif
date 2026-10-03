import { z } from "zod";

/** Enforcement verdicts applied to an interaction (interaction-gateway contract). */
export const verdictSchema = z.enum(["allow", "block", "escalate", "redact"]);

/** Actions a detection rule or semantic check maps its evidence to. `flag` forwards the content and records the match as flagged for review (maps to the `allow` verdict with a flagged audit annotation). */
export const actionSchema = z.enum(["allow", "block", "flag", "redact"]);

/** Inspected directions: inbound prompts and outbound model/tool output. */
export const directionSchema = z.enum(["inbound", "outbound"]);

/** Signature-feed severity levels. */
export const severitySchema = z.enum(["critical", "high", "low", "medium"]);

/** Named strictness profiles. */
export const profileNameSchema = z.enum(["permissive", "standard", "strict"]);

/** A probability or confidence value in [0, 1]. */
export const probabilitySchema = z.number().min(0).max(1);

const NESTED_QUANTIFIER = /\([^()]*[+*][^()]*\)\s*(?:[+*]|\{\d+,\s*\})/;
const HUGE_REPEAT = /\{\s*\d{4,}\s*,?\s*\d*\s*\}/;

/**
 * Bounded-complexity check for policy regexes: the pattern must compile and
 * must not carry catastrophic-backtracking shapes (unbounded quantifiers over
 * groups that already contain unbounded quantifiers) or enormous repeat counts.
 */
export function patternComplexityProblem(pattern: string): string {
	try {
		new RegExp(pattern);
	} catch {
		return "pattern does not compile";
	}
	if (NESTED_QUANTIFIER.test(pattern)) {
		return "pattern is unbounded: a group containing an unbounded quantifier is itself quantified";
	}
	if (HUGE_REPEAT.test(pattern)) {
		return "pattern is unbounded: repeat count is excessive";
	}
	return "";
}

const patternSchema = z
	.string()
	.min(1)
	.superRefine((pattern, ctx) => {
		const problem = patternComplexityProblem(pattern);
		if (problem !== "") {
			ctx.addIssue({ code: "custom", message: problem });
		}
	});

/** A custom regex detection rule defined by the policy. */
export const detectionRuleSchema = z.strictObject({
	action: actionSchema,
	directions: z.array(directionSchema).min(1),
	id: z.string().min(1),
	kind: z.string().min(1),
	pattern: patternSchema,
});

export type DetectionRule = z.infer<typeof detectionRuleSchema>;

/** Which built-in detector families are active. */
export const builtinFamiliesSchema = z.strictObject({
	encodingRescan: z.boolean(),
	entropyScan: z.boolean(),
	genericCredentials: z.boolean(),
	pii: z.boolean(),
	providerSecrets: z.boolean(),
});

/** Deterministic detection configuration: rules, built-in families, per-kind defaults. */
export const detectionConfigSchema = z.strictObject({
	builtins: builtinFamiliesSchema,
	defaultActions: z
		.record(z.string(), actionSchema)
		.refine((actions) => Object.keys(actions).length > 0, {
			message: "at least one per-kind default action is required",
		}),
	rules: z.array(detectionRuleSchema),
});

/** Structural-suspicion configuration for the signature engine. */
export const suspectConfigSchema = z.strictObject({
	action: verdictSchema,
	threshold: probabilitySchema,
});

/** Signature enforcement configuration (the feed itself lives outside the policy). */
export const signatureConfigSchema = z.strictObject({
	enabled: z.boolean(),
	perSignatureActions: z.record(z.string(), actionSchema),
	severityActions: z.record(severitySchema, actionSchema),
	suspect: suspectConfigSchema,
});

/** One budget rule: per consumer key and model scope, at least one limit, within a time window. */
export const budgetRuleSchema = z
	.strictObject({
		computeTimeMs: z.number().int().positive().optional(),
		costUsd: z.number().positive().optional(),
		key: z.string().min(1),
		modelScope: z.string().min(1),
		period: z.enum(["day", "hour", "month"]),
		requests: z.number().int().positive().optional(),
		tokens: z.number().int().positive().optional(),
	})
	.superRefine((rule, ctx) => {
		if (
			rule.computeTimeMs === undefined &&
			rule.costUsd === undefined &&
			rule.requests === undefined &&
			rule.tokens === undefined
		) {
			ctx.addIssue({
				code: "custom",
				message: "budget rule needs at least one limit (tokens, costUsd, requests, computeTimeMs)",
			});
		}
	});

/** Budget configuration: rules and the over-budget verdict. */
export const budgetConfigSchema = z.strictObject({
	overBudgetVerdict: verdictSchema,
	rules: z.array(budgetRuleSchema),
});

/** Permitted LLM models and endpoints. */
export const modelAllowlistSchema = z.strictObject({
	models: z
		.array(
			z.strictObject({
				endpoint: z.url().optional(),
				name: z.string().min(1),
			}),
		)
		.min(1),
});

/** Content shape limits applied before any scanning. */
export const shapeConfigSchema = z.strictObject({
	maxContentBytes: z.number().int().positive(),
});

/** Redaction configuration. */
export const redactionConfigSchema = z.strictObject({
	enabled: z.boolean(),
});

/** Evidence-to-verdict thresholds for one control in one direction. */
export const verdictThresholdsSchema = z.strictObject({
	block: probabilitySchema,
	escalate: probabilitySchema,
	redact: probabilitySchema,
});

/** Thresholds per control and per direction. */
export const controlThresholdsSchema = z.strictObject({
	detection: z.strictObject({
		inbound: verdictThresholdsSchema,
		outbound: verdictThresholdsSchema,
	}),
	semantic: z.strictObject({
		inbound: verdictThresholdsSchema,
		outbound: verdictThresholdsSchema,
	}),
	signatures: z.strictObject({
		inbound: verdictThresholdsSchema,
		outbound: verdictThresholdsSchema,
	}),
});

/** Which controls a profile runs. */
export const enabledControlsSchema = z.strictObject({
	detection: z.boolean(),
	semantic: z.boolean(),
	signatures: z.boolean(),
});

/** A strictness profile: its enabled-control set and its threshold set. */
export const profileSchema = z.strictObject({
	enabledControls: enabledControlsSchema,
	thresholds: controlThresholdsSchema,
});

export type Profile = z.infer<typeof profileSchema>;

/** Per-policy-subject assignment and optional deep-merge overrides. */
export const consumerSchema = z.strictObject({
	overrides: profileSchema.partial().optional(),
	profile: profileNameSchema,
});

/** The complete policy document: the single source of truth for all controls. */
export const policySchema = z
	.strictObject({
		consumers: z.record(z.string(), consumerSchema),
		controls: z.strictObject({
			allowlist: modelAllowlistSchema,
			budget: budgetConfigSchema,
			detection: detectionConfigSchema,
			enabled: z.boolean(),
			redaction: redactionConfigSchema,
			shape: shapeConfigSchema,
			signatures: signatureConfigSchema,
		}),
		defaults: z.strictObject({
			failureVerdict: verdictSchema,
			profile: profileNameSchema,
		}),
		profiles: z.strictObject({
			permissive: profileSchema,
			standard: profileSchema,
			strict: profileSchema,
		}),
		version: z.string().min(1),
	})
	.superRefine((policy, ctx) => {
		const seenRuleIds = new Set<string>();
		policy.controls.detection.rules.forEach((rule, index) => {
			if (seenRuleIds.has(rule.id)) {
				ctx.addIssue({
					code: "custom",
					message: `duplicate detection rule id: ${rule.id}`,
					path: ["controls", "detection", "rules", index, "id"],
				});
			}
			seenRuleIds.add(rule.id);
		});
	});

export type Policy = z.infer<typeof policySchema>;
export type PolicyInput = z.input<typeof policySchema>;

export type ParsePolicyResult =
	| { policy: Policy; success: true }
	| { issues: z.core.$ZodIssue[]; success: false };

/**
 * Validate a policy document. On failure the caller must keep the last valid
 * policy active and report the issues (fail closed when none exists).
 */
export function parsePolicy(input: unknown): ParsePolicyResult {
	const result = policySchema.safeParse(input);
	if (result.success) {
		return { policy: result.data, success: true };
	}
	return { issues: result.error.issues, success: false };
}
