/**
 * Fixed-answer test double for the semantic tier.
 *
 * **Test harness only.** This module is deliberately not re-exported from
 * `index.ts`, and no policy or runtime configuration value names a classifier —
 * so a double can only be reached by code that imports this file explicitly.
 * The product path constructs `createJevClassifier()` and nothing else.
 *
 * The double sits at the *adapter* boundary rather than the classifier boundary
 * on purpose: the real `decide()` call, and therefore the wire-to-public answer
 * mapping, stays under test.
 */

import type {
	EvaluateAdapterResult,
	EvaluateOptions,
	WireAnswer,
	WireNoulAnswer,
} from "@tanstack/ai/adapters";
import { BaseEvaluateAdapter } from "@tanstack/ai/adapters";
import type { SemanticClassifierOptions } from "./classifier.ts";
import { createSemanticClassifier } from "./classifier.ts";
import { SemanticInvalidAnswerError } from "./errors.ts";
import type { SemanticClassifier } from "./types.ts";

export interface FixedAnswerFixtures {
	/** P(true) for any check not listed in {@link probabilities}. */
	defaultProbability?: number;
	/** Resolved model id reported in `meta.model`. */
	model?: string;
	/** check id -> P(true) that check fired. */
	probabilities: Record<string, number>;
	/** Prompt tokens attributed to the call. */
	promptTokens?: number;
}

const DEFAULT_PROBABILITY = 0.02;
const DEFAULT_PROMPT_TOKENS = 42;

/** Deterministic evaluate adapter returning fixed wire answers. */
export class FixedEvaluateAdapter extends BaseEvaluateAdapter {
	override readonly name = "fixed-double";
	readonly fixtures: FixedAnswerFixtures;

	constructor(fixtures: FixedAnswerFixtures) {
		super({}, fixtures.model ?? "fixed-double");
		this.fixtures = fixtures;
	}

	override evaluate(options: EvaluateOptions): Promise<EvaluateAdapterResult> {
		options.logger.request(`activity=evaluate provider=${this.name} model=${this.model}`, {
			model: this.model,
			provider: this.name,
		});

		try {
			const answers: Record<string, WireAnswer> = {};
			for (const key of Object.keys(options.questions)) {
				const probability = this.probabilityFor(key);
				const wire: WireNoulAnswer = { noul: probability, type: "noul" };
				answers[key] = wire;
			}

			const promptTokens = this.fixtures.promptTokens ?? DEFAULT_PROMPT_TOKENS;
			return Promise.resolve({
				answers,
				model: this.model,
				usage: {
					completionTokens: 0,
					promptTokens,
					totalTokens: promptTokens,
				},
			});
		} catch (error) {
			options.logger.errors(`${this.name}.evaluate fatal`, {
				error,
				source: `${this.name}.evaluate`,
			});
			throw error;
		}
	}

	private probabilityFor(checkId: string): number {
		const mapped = this.fixtures.probabilities[checkId];
		if (mapped !== undefined) {
			if (mapped < 0 || mapped > 1 || Number.isNaN(mapped)) {
				throw new SemanticInvalidAnswerError(
					`semantic: fixture for check "${checkId}" must be a probability between 0 and 1`,
				);
			}
			return mapped;
		}
		return this.fixtures.defaultProbability ?? DEFAULT_PROBABILITY;
	}
}

/**
 * Convenience wrapper: a `SemanticClassifier` whose answers come from fixed
 * fixtures instead of Jev. Inject it through the test harness only.
 */
export function createFixedClassifier(
	fixtures: FixedAnswerFixtures,
	options: SemanticClassifierOptions,
): SemanticClassifier {
	return createSemanticClassifier(new FixedEvaluateAdapter(fixtures), {
		...options,
		name: "fixed-double",
	});
}
