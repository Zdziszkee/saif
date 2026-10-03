import { describe, expect, it } from "bun:test";
import type { EvaluateAdapterResult, EvaluateOptions, WireAnswer } from "@tanstack/ai/adapters";
import { BaseEvaluateAdapter } from "@tanstack/ai/adapters";

import { createSemanticClassifier } from "#/control/semantic/classifier.ts";
import { createFixedClassifier } from "#/control/semantic/double.ts";
import type { SemanticCheck, SemanticInput } from "#/control/semantic/index.ts";

import { answerOf, makeCheck } from "./helpers.ts";

const FIXED_PROBABILITY = 0.93;
const DEFAULT_PROBABILITY = 0.01;
const JUDGE_THRESHOLD = 0.75;
const RECORDED_PROBABILITY = 0.1;
const PROMPT_INJECTION_ID = "prompt_injection";

const input: SemanticInput = {
	content: "hello",
	direction: "inbound",
	role: "user",
};

const checks: readonly SemanticCheck[] = [
	makeCheck(),
	makeCheck({ id: "insider_trading", instructions: "Insider trading?" }),
];

function noul(probability: number): WireAnswer {
	return { noul: probability, type: "noul" };
}

class RecordingAdapter extends BaseEvaluateAdapter {
	override readonly name = "recording";
	readonly asked: string[] = [];

	constructor() {
		super({}, "recording-model");
	}

	override evaluate(options: EvaluateOptions): Promise<EvaluateAdapterResult> {
		options.logger.request("recording");
		this.asked.push(...Object.keys(options.questions));
		const answers: Record<string, WireAnswer> = {};
		for (const id of Object.keys(options.questions)) {
			answers[id] = noul(RECORDED_PROBABILITY);
		}
		return Promise.resolve({
			answers,
			model: "recording-model",
			usage: { completionTokens: 0, promptTokens: 1, totalTokens: 1 },
		});
	}
}

describe("policy-driven check sets", () => {
	it("uses a per-call check set so a policy hot reload takes effect", async () => {
		const adapter = new RecordingAdapter();
		const classifier = createSemanticClassifier(adapter, { checks });

		const reloaded: readonly SemanticCheck[] = [
			makeCheck({
				id: "privacy_violation",
				instructions: "Does this violate the privacy policy?",
				thresholds: {},
			}),
		];
		await classifier.evaluate(input, { checks: reloaded });

		expect(adapter.asked).toEqual(["privacy_violation"]);
	});

	it("accepts an arbitrary judge-authored check with no code change", async () => {
		const judgeCheck = makeCheck({
			id: "insider_trading",
			instructions: "Does this text contain insider trading information?",
			thresholds: { inbound: { block: JUDGE_THRESHOLD } },
		});
		const adapter = new RecordingAdapter();
		const classifier = createSemanticClassifier(adapter, {
			checks: [judgeCheck],
		});

		const evidence = await classifier.evaluate(input);

		expect(adapter.asked).toEqual(["insider_trading"]);
		expect(answerOf(evidence, "insider_trading").probability).toBe(RECORDED_PROBABILITY);
	});

	it("asks every enabled check in one round trip", async () => {
		const adapter = new RecordingAdapter();
		const classifier = createSemanticClassifier(adapter, { checks });

		await classifier.evaluate(input);

		expect(adapter.asked.length).toBe(checks.length);
	});
});

describe("test double", () => {
	it("produces fixed evidence without any network", async () => {
		const classifier = createFixedClassifier(
			{
				defaultProbability: DEFAULT_PROBABILITY,
				probabilities: { [PROMPT_INJECTION_ID]: FIXED_PROBABILITY },
			},
			{ checks },
		);

		const evidence = await classifier.evaluate(input);

		expect(answerOf(evidence, "prompt_injection").probability).toBe(FIXED_PROBABILITY);
		expect(answerOf(evidence, "insider_trading").probability).toBe(DEFAULT_PROBABILITY);
		expect(evidence.meta.classifier).toBe("fixed-double");
	});
});
