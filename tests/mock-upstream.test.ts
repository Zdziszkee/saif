import { describe, expect, it } from "bun:test";

import { buildMockJsonBody, buildMockStreamBody } from "../scripts/mock-upstream.ts";

const BODY = {
	messages: [{ content: "Contact alice@example.com please", role: "user" }],
	model: "local-small",
};

describe("mock upstream", () => {
	it("streams deltas, usage, and DONE", () => {
		const sse = buildMockStreamBody(BODY);
		expect(sse).toContain("Mock reply.");
		expect(sse).toContain("data: [DONE]");
		expect(sse).toContain("usage");
		expect(sse).toContain("alice@example.com");
	});

	it("echoes redacted content verbatim when given redacted input", () => {
		const sse = buildMockStreamBody({
			messages: [{ content: "Contact [EMAIL] please", role: "user" }],
			model: "local-small",
		});
		expect(sse).toContain("[EMAIL]");
		expect(sse).not.toContain("alice@example.com");
	});

	it("builds a buffered completion with matching usage", () => {
		const reply = buildMockJsonBody({ ...BODY, stream: false });
		expect(reply).toMatchObject({
			choices: [{ message: { role: "assistant" } }],
			model: "local-small",
			object: "chat.completion",
		});
		const choices = reply.choices;
		expect(choices[0]?.message.content).toContain("Echo:");
	});
});
