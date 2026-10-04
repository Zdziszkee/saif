/**
 * Worst-wins verdict helpers shared by every control tier.
 *
 * Deterministic, signature, and semantic tiers each ranked actions with
 * an inline `OUTCOME_SEVERITY[x] > OUTCOME_SEVERITY[worst]` loop and each
 * mapped the winning `flag` action to an `allow` verdict plus a `flag`
 * hit. The single severity table in `./types.ts` exists so tiers cannot
 * drift; these helpers keep the comparisons on that table instead of
 * copying the loop per tier.
 */

import { OUTCOME_SEVERITY, type Verdict } from "./types.ts";

/** Outcome ranks every tier compares: verdicts plus the forwarding `flag`. */
export type RankedOutcome = Verdict | "flag";

/** True when `next` outranks `current` on the shared severity table. */
export function isMoreSevere(next: RankedOutcome, current: RankedOutcome): boolean {
	return OUTCOME_SEVERITY[next] > OUTCOME_SEVERITY[current];
}

/** Worst of `outcomes`; empty input ranks as `allow`. */
export function worstOutcome<O extends RankedOutcome>(outcomes: readonly O[]): O | "allow" {
	let worst: O | "allow" = "allow";
	for (const outcome of outcomes) {
		if (isMoreSevere(outcome, worst)) {
			worst = outcome;
		}
	}
	return worst;
}

/**
 * Split a winning action into its gateway verdict and hit annotation.
 * `flag` forwards content (`allow`) while marking the hit for review;
 * every other action maps to itself on both sides.
 */
export function splitOutcome(worst: RankedOutcome): {
	hitVerdict: Verdict | "flag";
	verdict: Verdict;
} {
	return worst === "flag"
		? { hitVerdict: "flag", verdict: "allow" }
		: { hitVerdict: worst, verdict: worst };
}
