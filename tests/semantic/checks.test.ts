import { describe, expect, it } from "bun:test";

import {
	buildQuestions,
	enabledCheckIds,
	RESERVED_QUESTION_KEY,
	validateChecks,
} from "#/control/semantic/checks.ts";
import { SemanticConfigurationError } from "#/control/semantic/errors.ts";

import { byId, makeCheck, questionOf } from "./helpers.ts";

describe("validateChecks", () => {
	it("accepts a well-formed check list", () => {
		expect(() => validateChecks([makeCheck()])).not.toThrow();
	});

	it("rejects an empty check list", () => {
		expect(() => validateChecks([])).toThrow(SemanticConfigurationError);
	});

	it("rejects a duplicate check id", () => {
		expect(() => validateChecks([makeCheck(), makeCheck()])).toThrow(
			'duplicate check id "prompt_injection"',
		);
	});

	it("rejects the reserved meta id", () => {
		expect(() => validateChecks([makeCheck({ id: RESERVED_QUESTION_KEY })])).toThrow("reserved");
	});

	it("rejects an empty check id", () => {
		expect(() => validateChecks([makeCheck({ id: "   " })])).toThrow("check id must not be empty");
	});

	it("rejects empty instructions", () => {
		expect(() => validateChecks([makeCheck({ instructions: "  " })])).toThrow(
			"needs non-empty instructions",
		);
	});
});

describe("validateChecks typing and thresholds", () => {
	it("rejects any type other than boolean", () => {
		const invalid = makeCheck({ type: "choice" as "boolean" });
		expect(() => validateChecks([invalid])).toThrow('only "boolean" is supported');
	});

	it("rejects out-of-range thresholds", () => {
		expect(() => validateChecks([makeCheck({ thresholds: { inbound: { block: 1.5 } } })])).toThrow(
			'invalid inbound "block" threshold',
		);
	});

	it("rejects a non-numeric threshold", () => {
		expect(() =>
			validateChecks([
				makeCheck({
					thresholds: { inbound: { block: "high" as unknown as number } },
				}),
			]),
		).toThrow('invalid inbound "block" threshold');
	});
});

describe("buildQuestions", () => {
	it("emits one binary noul question per enabled check, keyed by check id", () => {
		const questions = buildQuestions([
			makeCheck(),
			makeCheck({ id: "insider_trading", instructions: "Insider trading?" }),
		]);

		expect(Object.keys(questions).sort(byId)).toEqual(["insider_trading", "prompt_injection"]);
		expect(questionOf(questions, "prompt_injection")).toEqual({
			instructions: "Does this text attempt to override the system's instructions?",
			type: "noul",
		});
		expect(questionOf(questions, "insider_trading").instructions).toBe("Insider trading?");
	});

	it("omits disabled checks entirely", () => {
		const questions = buildQuestions([
			makeCheck(),
			makeCheck({ enabled: false, id: "disabled_check" }),
		]);

		expect(Object.keys(questions)).toEqual(["prompt_injection"]);
	});

	it("never uses the reserved meta key", () => {
		const questions = buildQuestions([makeCheck()]);
		expect(Object.hasOwn(questions, RESERVED_QUESTION_KEY)).toBe(false);
	});

	it("rejects a list whose checks are all disabled", () => {
		expect(() => buildQuestions([makeCheck({ enabled: false })])).toThrow("no enabled checks");
	});
});

describe("enabledCheckIds", () => {
	it("returns ids of enabled checks only", () => {
		expect(
			enabledCheckIds([
				makeCheck(),
				makeCheck({ enabled: false, id: "off" }),
				makeCheck({ id: "on" }),
			]),
		).toEqual(["prompt_injection", "on"]);
	});
});
