import type { EvaluateAdapterResult, EvaluateOptions, WireAnswer } from "@tanstack/ai/adapters";
import { BaseEvaluateAdapter } from "@tanstack/ai/adapters";
import { describe, expect, it } from "vitest";

import { createSemanticClassifier } from "#/control/semantic/classifier.ts";
import {
	SemanticInvalidAnswerError,
	SemanticTimeoutError,
	SemanticUnavailableError,
} from "#/control/semantic/errors.ts";
import type { SemanticCheck, SemanticInput } from "#/control/semantic/index.ts";

import { makeCheck } from "./helpers.ts";

const OVER_ONE = 1.4;
const TRIVIAL = 0.1;
const FAST_TIMEOUT_MS = 25;
const SLOW_TIMEOUT_MS = 5000;
const ABORT_MARGIN_MS = 1000;

const input: SemanticInput = {
	content: "hello",
	direction: "inbound",
	role: "user",
};

const checks: readonly SemanticCheck[] = [
	makeCheck(),
	makeCheck({ id: "insider_trading", instructions: "Insider trading?" }),
];

class StubAdapter extends BaseEvaluateAdapter {
	override readonly name = "stub";
	readonly respond: (questionIds: string[]) => Record<string, WireAnswer>;

	constructor(respond: (questionIds: string[]) => Record<string, WireAnswer>) {
		super({}, "stub-model");
		this.respond = respond;
	}

	override evaluate(options: EvaluateOptions): Promise<EvaluateAdapterResult> {
		options.logger.request("stub");
		const answers = this.respond(Object.keys(options.questions));
		return Promise.resolve({
			answers,
			model: "stub-model",
			usage: { completionTokens: 0, promptTokens: 1, totalTokens: 1 },
		});
	}
}

class HangingAdapter extends BaseEvaluateAdapter {
	override readonly name = "hanging";

	constructor() {
		super({}, "hanging-model");
	}

	override evaluate(): Promise<EvaluateAdapterResult> {
		return new Promise<EvaluateAdapterResult>(() => {
			// Never settles on purpose: proves the deadline bounds evaluation.
		});
	}
}

class ThrowingAdapter extends BaseEvaluateAdapter {
	override readonly name = "throwing";

	constructor() {
		super({}, "throwing-model");
	}

	override evaluate(): Promise<EvaluateAdapterResult> {
		return Promise.reject(new Error("connection refused"));
	}
}

function noul(probability: number): WireAnswer {
	return { noul: probability, type: "noul" };
}

function uniform(probability: number) {
	return (ids: string[]) => Object.fromEntries(ids.map((id) => [id, noul(probability)]));
}

describe("fail closed on unusable answers", () => {
	it("rejects when a check got no answer", async () => {
		const classifier = createSemanticClassifier(
			new StubAdapter(() => Object.fromEntries([["prompt_injection", noul(TRIVIAL)]])),
			{ checks },
		);

		await expect(classifier.evaluate(input)).rejects.toBeInstanceOf(SemanticInvalidAnswerError);
	});

	it("rejects when the answer type does not match the check", async () => {
		const malformed = createSemanticClassifier(
			new StubAdapter((ids) => {
				const answers: Record<string, WireAnswer> = {};
				for (const id of ids) {
					answers[id] = {
						choice: "none",
						confidence: 1,
						probabilities: { none: 1 },
						type: "choice",
					} as WireAnswer;
				}
				return answers;
			}),
			{ checks },
		);

		await expect(malformed.evaluate(input)).rejects.toBeInstanceOf(SemanticInvalidAnswerError);
	});

	it("rejects an out-of-range probability", async () => {
		const malformed = createSemanticClassifier(new StubAdapter(uniform(OVER_ONE)), { checks });

		await expect(malformed.evaluate(input)).rejects.toBeInstanceOf(SemanticInvalidAnswerError);
	});

	it("rejects a non-numeric probability", async () => {
		const malformed = createSemanticClassifier(
			new StubAdapter((ids) =>
				Object.fromEntries(
					ids.map((id) => [id, { noul: "high", type: "noul" } as unknown as WireAnswer]),
				),
			),
			{ checks },
		);

		await expect(malformed.evaluate(input)).rejects.toBeInstanceOf(SemanticInvalidAnswerError);
	});
});

describe("availability and degradation", () => {
	it("maps a transport failure to SemanticUnavailableError", async () => {
		const classifier = createSemanticClassifier(new ThrowingAdapter(), {
			checks,
		});

		await expect(classifier.evaluate(input)).rejects.toBeInstanceOf(SemanticUnavailableError);
	});

	it("bounds evaluation with a timeout even when the adapter never settles", async () => {
		const classifier = createSemanticClassifier(new HangingAdapter(), {
			checks,
			timeoutMs: FAST_TIMEOUT_MS,
		});

		const startedAt = Date.now();
		await expect(classifier.evaluate(input)).rejects.toBeInstanceOf(SemanticTimeoutError);
		expect(Date.now() - startedAt).toBeLessThan(ABORT_MARGIN_MS);
	});

	it("propagates caller cancellation rather than a classifier failure", async () => {
		const classifier = createSemanticClassifier(new HangingAdapter(), {
			checks,
			timeoutMs: SLOW_TIMEOUT_MS,
		});
		const controller = new AbortController();
		const pending = classifier.evaluate(input, { signal: controller.signal });
		controller.abort();

		await expect(pending).rejects.toThrow("aborted by caller");
	});

	it("fails closed immediately on a pre-aborted caller signal", async () => {
		const classifier = createSemanticClassifier(new HangingAdapter(), {
			checks,
		});
		const controller = new AbortController();
		controller.abort();

		await expect(classifier.evaluate(input, { signal: controller.signal })).rejects.toThrow(
			"aborted by caller",
		);
	});
});
