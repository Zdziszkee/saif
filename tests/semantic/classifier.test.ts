import type { EvaluateAdapterResult, EvaluateOptions, WireAnswer } from "@tanstack/ai/adapters";
import { BaseEvaluateAdapter } from "@tanstack/ai/adapters";
import { describe, expect, it } from "vitest";

import { createSemanticClassifier } from "#/control/semantic/classifier.ts";
import type {
	SemanticAnswer,
	SemanticCheck,
	SemanticEvidence,
	SemanticInput,
} from "#/control/semantic/index.ts";

import { answerOf, byId, flagOf, makeCheck } from "./helpers.ts";

/** Fixtures named for what each one demonstrates. */
const FIERCE_INJECTION = 0.91;
const BENIGN = 0.12;
const FAIR_COIN = 0.5;
const DECISIVE_AT_FLOOR = 0.7;
const JUST_BELOW_FLOOR = 0.69;
const NEAR_CERTAIN_NEGATIVE = 0.02;
const STRICT_FLOOR = 0.95;
const STRONG_EVIDENCE = 0.95;
const UNCERTAIN = 0.5;
const FIXED_USAGE_TOKENS = 7;

const input: SemanticInput = {
	content: "hello",
	direction: "inbound",
	role: "user",
};

const checks: readonly SemanticCheck[] = [
	makeCheck(),
	makeCheck({ id: "insider_trading", instructions: "Insider trading?" }),
];

const firstCheck: SemanticCheck = makeCheck();

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
			usage: {
				completionTokens: 0,
				promptTokens: FIXED_USAGE_TOKENS,
				totalTokens: FIXED_USAGE_TOKENS,
			},
		});
	}
}

function noul(probability: number): WireAnswer {
	return { noul: probability, type: "noul" };
}

function uniform(probability: number) {
	return (ids: string[]) => Object.fromEntries(ids.map((id) => [id, noul(probability)]));
}

function stubClassifier(
	respond: (questionIds: string[]) => Record<string, WireAnswer>,
	options: { timeoutMs?: number } = {},
) {
	return createSemanticClassifier(new StubAdapter(respond), {
		checks,
		...options,
	});
}

describe("answer contract", () => {
	it("returns the probability and value for every enabled check", async () => {
		const classifier = stubClassifier((ids) =>
			Object.fromEntries(
				ids.map((id, index) => [id, noul(index === 0 ? FIERCE_INJECTION : BENIGN)]),
			),
		);

		const evidence = await classifier.evaluate(input);

		expect(answerOf(evidence, "prompt_injection")).toEqual({
			probability: FIERCE_INJECTION,
			type: "boolean",
			value: true,
		});
		expect(answerOf(evidence, "insider_trading")).toEqual({
			probability: BENIGN,
			type: "boolean",
			value: false,
		});
	});

	it("treats P(true) = 0.5 as fired, matching BooleanAnswer", async () => {
		const classifier = stubClassifier(uniform(FAIR_COIN));

		const evidence = await classifier.evaluate(input);

		expect(answerOf(evidence, "prompt_injection").value).toBe(true);
		expect(answerOf(evidence, "prompt_injection").probability).toBe(FAIR_COIN);
	});

	it("reports model, classifier name, latency and usage in meta", async () => {
		const classifier = stubClassifier(uniform(BENIGN));

		const evidence = await classifier.evaluate(input);

		expect(evidence.meta.classifier).toBe("stub");
		expect(evidence.meta.usage).toEqual({
			completionTokens: 0,
			promptTokens: FIXED_USAGE_TOKENS,
			totalTokens: FIXED_USAGE_TOKENS,
		});
		expect(evidence.meta.latencyMs).toBeGreaterThanOrEqual(0);
	});

	it("never asks about disabled checks", async () => {
		const asked: string[] = [];
		const classifier = createSemanticClassifier(
			new StubAdapter((ids) => {
				asked.push(...ids);
				return uniform(BENIGN)(ids);
			}),
			{ checks: [...checks, { ...firstCheck, enabled: false, id: "off" }] },
		);

		await classifier.evaluate(input);

		expect(asked.sort(byId)).toEqual(["insider_trading", "prompt_injection"]);
	});
});

describe("type-level guarantees", () => {
	it("carries no confidence field on a boolean answer", async () => {
		const classifier = stubClassifier(uniform(DECISIVE_AT_FLOOR));
		const evidence = await classifier.evaluate(input);
		const answer: SemanticAnswer = answerOf(evidence, "prompt_injection");

		expect(answer.probability).toBe(DECISIVE_AT_FLOOR);
		const absent: "confidence" extends keyof SemanticAnswer ? never : true = true;
		expect(absent).toBe(true);
	});

	it("carries no verdict field on evidence", async () => {
		const classifier = stubClassifier(uniform(DECISIVE_AT_FLOOR));
		const evidence: SemanticEvidence = await classifier.evaluate(input);

		expect(evidence.anyUncertain).toBe(false);
		expect(Object.hasOwn(evidence, "verdict")).toBe(false);
		const absent: "verdict" extends keyof SemanticEvidence ? never : true = true;
		expect(absent).toBe(true);
	});
});

describe("decisiveness floors", () => {
	it("marks a decisive answer as certain at exactly the floor", async () => {
		const classifier = createSemanticClassifier(new StubAdapter(uniform(DECISIVE_AT_FLOOR)), {
			checks,
			floors: { decisiveness: DECISIVE_AT_FLOOR },
		});

		const evidence = await classifier.evaluate(input);

		expect(flagOf(evidence, "prompt_injection")).toBe(false);
		expect(evidence.anyUncertain).toBe(false);
	});

	it("marks an indecisive answer as uncertain just below the floor", async () => {
		const classifier = createSemanticClassifier(new StubAdapter(uniform(JUST_BELOW_FLOOR)), {
			checks,
			floors: { decisiveness: DECISIVE_AT_FLOOR },
		});

		const evidence = await classifier.evaluate(input);

		expect(flagOf(evidence, "prompt_injection")).toBe(true);
		expect(evidence.anyUncertain).toBe(true);
	});

	it("measures decisiveness as max(p, 1 - p)", async () => {
		const classifier = createSemanticClassifier(new StubAdapter(uniform(NEAR_CERTAIN_NEGATIVE)), {
			checks,
			floors: { decisiveness: STRICT_FLOOR },
		});

		const evidence = await classifier.evaluate(input);

		expect(flagOf(evidence, "prompt_injection")).toBe(false);
	});

	it("aggregates anyUncertain across checks", async () => {
		const classifier = createSemanticClassifier(
			new StubAdapter((ids) =>
				Object.fromEntries(
					ids.map((id) => [id, noul(id === "prompt_injection" ? STRONG_EVIDENCE : UNCERTAIN)]),
				),
			),
			{ checks, floors: { decisiveness: 0.8 } },
		);

		const evidence = await classifier.evaluate(input);

		expect(flagOf(evidence, "prompt_injection")).toBe(false);
		expect(flagOf(evidence, "insider_trading")).toBe(true);
		expect(evidence.anyUncertain).toBe(true);
	});
});
