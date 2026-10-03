import { describe, expect, it } from "bun:test";

import { normalizeGuardResult } from "#/lib/guard-result.ts";

const MeaninglessNumber = 42;

describe("guard result normalization", () => {
	it("passes a well-formed guard response through", () => {
		const body = {
			detections: [],
			feedVersion: "abc",
			matches: [],
			redactedText: "hello",
			verdict: "allow",
		};
		expect(normalizeGuardResult(body)).toEqual(body);
	});

	it("passes error bodies through", () => {
		const body = { error: "invalid_request", reason: "too short" };
		expect(normalizeGuardResult(body)).toMatchObject({ error: "invalid_request" });
	});

	it("replaces malformed bodies with an error view", () => {
		for (const malformed of [
			{},
			null,
			"oops",
			MeaninglessNumber,
			{ detections: [], verdict: "allow" },
		]) {
			expect(normalizeGuardResult(malformed)).toMatchObject({ error: "invalid_response" });
		}
	});
});
