import { z } from "zod";

import type { DetectionKind, DetectionType } from "#/control/detectors.ts";
import { detectionTypes } from "#/control/detectors.ts";

export const verdictSchema = z.enum(["allow", "block", "escalate", "redact"]);
export type Verdict = z.infer<typeof verdictSchema>;

export const directionSchema = z.enum(["input", "output"]);
export type Direction = z.infer<typeof directionSchema>;

export const surfaceSchema = z.enum(["output", "prompt", "tool-call"]);
export type Surface = z.infer<typeof surfaceSchema>;

export const severitySchema = z.enum(["critical", "high", "low", "medium"]);
export type Severity = z.infer<typeof severitySchema>;

const directionalVerdictsSchema = z.object({
	input: verdictSchema,
	output: verdictSchema,
});
export type DirectionalVerdicts = z.infer<typeof directionalVerdictsSchema>;

const deterministicActionsSchema = z.object({
	pii: directionalVerdictsSchema,
	secret: directionalVerdictsSchema,
});
export type DeterministicActions = z.infer<typeof deterministicActionsSchema>;

const detectionTypeSchema = z.enum(detectionTypes);
const typeOverridesSchema = z.partialRecord(detectionTypeSchema, directionalVerdictsSchema);

const severityActionsSchema = z.object({
	critical: verdictSchema.optional(),
	high: verdictSchema.optional(),
	low: verdictSchema.optional(),
	medium: verdictSchema.optional(),
});
export type SeverityActions = z.infer<typeof severityActionsSchema>;

export const firstLayerPolicySchema = z.object({
	deterministic: z.object({
		actions: deterministicActionsSchema,
		enabled: z.boolean(),
		minConfidence: z.number().min(0).max(1),
		suspectAction: verdictSchema,
		typeOverrides: typeOverridesSchema,
	}),
	signatures: z.object({
		defaultAction: verdictSchema,
		enabled: z.boolean(),
		severityActions: severityActionsSchema,
	}),
});
export type FirstLayerPolicy = z.infer<typeof firstLayerPolicySchema>;

export const defaultFirstLayerPolicy: FirstLayerPolicy = {
	deterministic: {
		actions: {
			pii: { input: "redact", output: "redact" },
			secret: { input: "block", output: "redact" },
		},
		enabled: true,
		minConfidence: 0.4,
		suspectAction: "redact",
		typeOverrides: {},
	},
	signatures: {
		defaultAction: "block",
		enabled: true,
		severityActions: { low: "escalate", medium: "escalate" },
	},
};

export function surfaceDirection(surface: Surface): Direction {
	return surface === "output" ? "output" : "input";
}

export function resolveDeterministicAction(
	policy: FirstLayerPolicy,
	detection: { kind: DetectionKind; type: DetectionType; validated: boolean },
	direction: Direction,
): Verdict {
	if (!detection.validated) {
		return policy.deterministic.suspectAction;
	}
	const override = policy.deterministic.typeOverrides[detection.type];
	if (override !== undefined) {
		return override[direction];
	}
	return policy.deterministic.actions[detection.kind][direction];
}

export function resolveSignatureAction(
	policy: FirstLayerPolicy,
	severity: Severity,
	actionOverride: Verdict | undefined,
): Verdict {
	if (actionOverride !== undefined) {
		return actionOverride;
	}
	return policy.signatures.severityActions[severity] ?? policy.signatures.defaultAction;
}

const verdictRank: Record<Verdict, number> = { allow: 0, block: 3, escalate: 2, redact: 1 };

export function worstVerdict(verdicts: readonly Verdict[]): Verdict {
	let worst: Verdict = "allow";
	for (const verdict of verdicts) {
		if (verdictRank[verdict] > verdictRank[worst]) {
			worst = verdict;
		}
	}
	return worst;
}
