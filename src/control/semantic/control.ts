/**
 * Semantic control (pipeline stage 4, runs last): the costly AI tier.
 *
 * Enabled policy checks are evaluated in one decision-model round trip and
 * each answer probability is mapped through its per-direction threshold
 * ladder (block → redact → flag, else allow). The worst check wins.
 * Classification stays advisory — only this mapping produces verdicts — and
 * classifier failures propagate so the pipeline fails closed.
 */

import { type Control, type ControlResult, OUTCOME_SEVERITY, type Verdict } from "../types.ts";
import { SemanticInvalidAnswerError } from "./errors.ts";
import type {
	SemanticCheck,
	SemanticClassifier,
	SemanticDirection,
	SemanticEvidence,
} from "./types.ts";

export interface SemanticControlOptions {
	checks: readonly SemanticCheck[];
	classifier: SemanticClassifier;
}

function ladderVerdict(
	probability: number,
	ladder: { block?: number; flag?: number; redact?: number } | undefined,
): "allow" | "block" | "flag" | "redact" {
	if (ladder?.block !== undefined && probability >= ladder.block) {
		return "block";
	}
	if (ladder?.redact !== undefined && probability >= ladder.redact) {
		return "redact";
	}
	if (ladder?.flag !== undefined && probability >= ladder.flag) {
		return "flag";
	}
	return "allow";
}

interface ScoredChecks {
	detail: string;
	kind: string;
	outcome: "allow" | "block" | "flag" | "redact";
}

function scoreChecks(
	checks: readonly SemanticCheck[],
	evidence: SemanticEvidence,
	direction: SemanticDirection,
): ScoredChecks {
	let worst: "allow" | "block" | "flag" | "redact" = "allow";
	let worstCheck = "";
	const scored: string[] = [];
	for (const check of checks) {
		const answer = evidence.answers[check.id];
		if (answer === undefined) {
			throw new SemanticInvalidAnswerError(`semantic: no answer returned for check "${check.id}"`);
		}
		// A check with no ladder for this direction has no opinion on it —
		// same as a policy rule scoped to the other direction in the
		// deterministic tier. Skipping must never borrow the other
		// direction's strictness.
		const ladder = check.thresholds[direction];
		if (ladder === undefined) {
			continue;
		}
		const outcome = ladderVerdict(answer.probability, ladder);
		scored.push(`${check.id}=${answer.probability.toFixed(2)}`);
		if (OUTCOME_SEVERITY[outcome] > OUTCOME_SEVERITY[worst]) {
			worst = outcome;
			worstCheck = check.id;
		}
	}
	return { detail: scored.join(", "), kind: worstCheck, outcome: worst };
}

function resultForScore(scored: ScoredChecks, uncertain: boolean): ControlResult {
	if (uncertain && scored.outcome === "allow") {
		return {
			hit: {
				controlId: "semantic",
				detail: `uncertain answers: ${scored.detail}`,
				kind: "semantic-uncertain",
				verdict: "flag",
			},
			verdict: "allow",
		};
	}
	if (scored.outcome === "allow") {
		return { verdict: "allow" };
	}
	const verdict: Verdict = scored.outcome === "flag" ? "allow" : scored.outcome;
	return {
		hit: {
			controlId: "semantic",
			detail: `${scored.kind}: ${scored.detail}`,
			kind: scored.kind,
			verdict: scored.outcome === "flag" ? "flag" : scored.outcome,
		},
		verdict,
	};
}

export function createSemanticControl(options: SemanticControlOptions): Control {
	return {
		id: "semantic",
		inspect: async (interaction): Promise<ControlResult> => {
			const direction: SemanticDirection = interaction.direction;
			const checks = options.checks.filter((check) => check.enabled);
			if (checks.length === 0) {
				return { verdict: "allow" };
			}
			const evidence = await options.classifier.evaluate({
				content: interaction.content,
				direction,
				role: interaction.direction === "inbound" ? "user" : "assistant",
			});
			return resultForScore(scoreChecks(checks, evidence, direction), evidence.anyUncertain);
		},
	};
}
