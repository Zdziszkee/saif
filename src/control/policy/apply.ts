/**
 * Central policy verdict mapping (task 8.1).
 *
 * Pure functions from evidence to verdicts — no I/O, no model calls, no
 * clock. Tiers keep doing what they do (detecting, matching, classifying),
 * and everything they report funnels through here to become exactly one
 * verdict per direction:
 *
 * - Discrete tier actions (`allow | flag | redact | block`, plus `escalate`
 *   from the feed) compete worst-wins on the shared severity order.
 * - `flag` is the WARN action: the content is forwarded but raised for
 *   review (`flagged: true`). It composes — `redact` + `flag` yields
 *   raised-and-redacted, which is how a policy warns on something it still
 *   scrubs (e.g. a badge number next to a flagged codename).
 * - Semantic check probabilities map through the PROFILE's threshold
 *   ladder (`block` → `redact` → `escalate`, strongest cutoff first),
 *   which is what makes identical Jev answers diverge across profiles —
 *   the strictness lives here, not in the model call.
 * - An exhausted budget maps to the policy's `overBudgetVerdict`.
 * - Unusable probabilities fail closed to `block`, like every other
 *   unusable input in this codebase.
 *
 * Wired into the request path by the pipeline: when a resolved profile is
 * available the pipeline maps control verdicts plus raw semantic answers
 * through this function, so profile strictness decides live traffic. Tiers
 * still map internally for standalone use; the pipeline prefers raw
 * answers over the semantic control's own verdict whenever it has both.
 */

import type { z } from "zod";
import { type Direction, OUTCOME_SEVERITY, type Verdict } from "../types.ts";
import type {
	budgetConfigSchema,
	controlThresholdsSchema,
	enabledControlsSchema,
	Policy,
	profileNameSchema,
} from "./schema.ts";

export type ProfileName = z.infer<typeof profileNameSchema>;
export type TierAction = "allow" | "block" | "escalate" | "flag" | "redact";
export type ControlThresholds = z.infer<typeof controlThresholdsSchema>;
export type EnabledControls = z.infer<typeof enabledControlsSchema>;
export type BudgetConfig = z.infer<typeof budgetConfigSchema>;

/** One tier's contribution: an already policy-mapped action plus its kind. */
export interface TierEvidence {
	action: TierAction;
	control: string;
	kind: string;
}

/** A profile with consumer overrides merged in: the effective strictness. */
export interface ResolvedProfile {
	enabledControls: EnabledControls;
	name: string;
	thresholds: ControlThresholds;
}

type ThresholdLadderPatch = Partial<ControlThresholds["semantic"]["inbound"]>;

interface DirectionPatch {
	inbound?: ThresholdLadderPatch | undefined;
	outbound?: ThresholdLadderPatch | undefined;
}

/** Deep-partial profile overrides: tweak one ladder without restating all six. */
export interface ProfileOverrides {
	enabledControls?: Partial<EnabledControls> | undefined;
	thresholds?:
		| {
				detection?: DirectionPatch | undefined;
				semantic?: DirectionPatch | undefined;
				signatures?: DirectionPatch | undefined;
		  }
		| undefined;
}

function mergeThresholds(
	base: ControlThresholds,
	overrides: ProfileOverrides["thresholds"],
): ControlThresholds {
	if (overrides === undefined) {
		return base;
	}
	return {
		detection: {
			inbound: { ...base.detection.inbound, ...overrides.detection?.inbound },
			outbound: { ...base.detection.outbound, ...overrides.detection?.outbound },
		},
		semantic: {
			inbound: { ...base.semantic.inbound, ...overrides.semantic?.inbound },
			outbound: { ...base.semantic.outbound, ...overrides.semantic?.outbound },
		},
		signatures: {
			inbound: { ...base.signatures.inbound, ...overrides.signatures?.inbound },
			outbound: { ...base.signatures.outbound, ...overrides.signatures?.outbound },
		},
	};
}

/**
 * Resolve the effective profile: the named base with a consumer's partial
 * overrides deep-merged over it. A group's own profile always wins for its
 * traffic; unknown names fall back to the policy default rather than
 * guessing strictness.
 */
export function resolveProfile(
	policy: Policy,
	name: ProfileName,
	overrides?: ProfileOverrides | undefined,
): ResolvedProfile {
	const base = policy.profiles[name] ?? policy.profiles[policy.defaults.profile];
	return {
		enabledControls: { ...base.enabledControls, ...overrides?.enabledControls },
		name,
		thresholds: mergeThresholds(base.thresholds, overrides?.thresholds),
	};
}

export interface ApplyPolicyInput {
	budget: { overBudget: boolean; overBudgetVerdict: BudgetConfig["overBudgetVerdict"] };
	detections: readonly TierEvidence[];
	direction: Direction;
	/** Tier evidence outside detection/signatures (allowlist, policy fallbacks, …). */
	other?: readonly TierEvidence[] | undefined;
	profile: ResolvedProfile;
	/** Raw check probabilities, P(true) per enabled check id. */
	semantic: Readonly<Record<string, number>>;
	signatures: readonly TierEvidence[];
}

export interface PolicyDecision {
	blockingControl?: string | undefined;
	flagged: boolean;
	verdict: Verdict;
}

type LadderAction = "block" | "escalate" | "redact";

/**
 * Walk a profile threshold ladder strongest-cutoff-first so any numbering
 * stays reachable: the first cutoff at or below the probability wins, and
 * ties break toward refusal on the shared severity order. Anything below
 * every cutoff allows.
 */
export function ladderVerdict(
	probability: number,
	ladder: { block: number; escalate: number; redact: number },
): Verdict {
	if (!(probability >= 0 && probability <= 1)) {
		return "block";
	}
	const ordered = (Object.keys(ladder) as LadderAction[]).sort(
		(a, b) => ladder[b] - ladder[a] || OUTCOME_SEVERITY[b] - OUTCOME_SEVERITY[a],
	);
	for (const action of ordered) {
		if (probability >= ladder[action]) {
			return action;
		}
	}
	return "allow";
}

interface WorstState {
	action: TierAction;
	control: string | undefined;
	flagged: boolean;
	kind: string;
}

function trackWorst(state: WorstState, action: TierAction, control: string, kind: string): void {
	if (action === "flag") {
		state.flagged = true;
	}
	if (OUTCOME_SEVERITY[action] > OUTCOME_SEVERITY[state.action]) {
		state.action = action;
		state.control = control;
		state.kind = kind;
	}
}

/**
 * Map one interaction's evidence to one verdict under a resolved profile.
 * Worst action wins across tiers; `flag` never refuses, only raises; a
 * clean sweep allows with no attribution.
 */
export function applyPolicy(input: ApplyPolicyInput): PolicyDecision {
	const state: WorstState = { action: "allow", control: undefined, flagged: false, kind: "" };
	for (const finding of input.detections) {
		trackWorst(state, finding.action, finding.control, finding.kind);
	}
	for (const match of input.signatures) {
		trackWorst(state, match.action, match.control, match.kind);
	}
	for (const item of input.other ?? []) {
		trackWorst(state, item.action, item.control, item.kind);
	}
	const ladder = input.profile.thresholds.semantic[input.direction];
	for (const [checkId, probability] of Object.entries(input.semantic)) {
		trackWorst(state, ladderVerdict(probability, ladder), "semantic", checkId);
	}
	if (input.budget.overBudget) {
		trackWorst(state, input.budget.overBudgetVerdict, "budget", "over-budget");
	}
	if (state.action === "allow") {
		return { flagged: state.flagged, verdict: "allow" };
	}
	if (state.action === "flag") {
		return { blockingControl: state.control, flagged: true, verdict: "allow" };
	}
	return {
		blockingControl: state.control,
		flagged: state.flagged,
		verdict: state.action,
	};
}
