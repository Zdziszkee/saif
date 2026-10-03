import { describe, expect, it } from "bun:test";
import type { SemanticInput } from "#/control/semantic/index.ts";
import { buildSemanticState, DEFAULT_MAX_CHARS } from "#/control/semantic/state.ts";

const input: SemanticInput = {
	content: "hello world",
	direction: "inbound",
	flags: ["pii_redacted"],
	role: "user",
};

const SHORT_CONTENT_LENGTH = 11;
const TRUNCATE_AT = 10;
const LONG_CONTENT = 50;
const OVERFLOW = 100;

describe("buildSemanticState allowlist", () => {
	it("serializes exactly the five allowlist fields and nothing else", () => {
		const state = buildSemanticState(input);

		expect(Object.keys(state).sort()).toEqual([
			"content",
			"contentLength",
			"direction",
			"flags",
			"role",
		]);
	});

	it("keeps out anything not in the allowlist", () => {
		const leaky = {
			...input,
			apiKey: "sk-secret",
			history: [{ content: "earlier", role: "user" }],
			systemPrompt: "you are a helpful assistant",
		} as SemanticInput & { systemPrompt: string; apiKey: string };

		const serialized = JSON.stringify(buildSemanticState(leaky));

		expect(serialized).not.toContain("helpful assistant");
		expect(serialized).not.toContain("sk-secret");
		expect(serialized).not.toContain("earlier");
	});
});

describe("buildSemanticState flags", () => {
	it("defaults flags to an empty list", () => {
		const state = buildSemanticState({
			content: "hi",
			direction: "inbound",
			role: "user",
		});
		expect(state.flags).toEqual([]);
	});

	it("copies flags rather than aliasing the caller's array", () => {
		const flags = ["pii_redacted"];
		const state = buildSemanticState({ ...input, flags });
		flags.push("mutated");

		expect(state.flags).toEqual(["pii_redacted"]);
	});
});

describe("buildSemanticState truncation", () => {
	it("truncates content to maxChars and reports the length as sent", () => {
		const state = buildSemanticState(
			{ ...input, content: "x".repeat(LONG_CONTENT) },
			{ maxChars: TRUNCATE_AT },
		);

		expect(state.content).toBe("x".repeat(TRUNCATE_AT));
		expect(state.contentLength).toBe(TRUNCATE_AT);
	});

	it("defaults truncation to DEFAULT_MAX_CHARS", () => {
		const long = "y".repeat(DEFAULT_MAX_CHARS + OVERFLOW);
		const state = buildSemanticState({ ...input, content: long });

		expect(state.content.length).toBe(DEFAULT_MAX_CHARS);
		expect(state.contentLength).toBe(DEFAULT_MAX_CHARS);
	});

	it("leaves short content untouched", () => {
		const state = buildSemanticState(input);
		expect(state.content).toBe("hello world");
		expect(state.contentLength).toBe(SHORT_CONTENT_LENGTH);
	});
});
