import { describe, expect, it } from "bun:test";
import { guardedChat } from "#/control/chat.ts";
import { auditSink, blockOn, pipelineWith, redactOn } from "./helpers/fixtures.ts";

describe("chat seam", () => {
	it("never asks the model when the prompt is blocked", async () => {
		const asked: string[] = [];
		const outcome = await guardedChat("please BLOCKME now", {
			ask: (prompt) => {
				asked.push(prompt);
				return Promise.resolve("answer");
			},
			groupId: "hr",
			pipeline: pipelineWith([blockOn("BLOCKME")]),
			userId: "alice",
		});
		expect(outcome.verdict).toBe("block");
		expect(outcome.rejection?.control).toBe("fixture-block");
		expect(asked).toHaveLength(0);
		expect(outcome.answer).toBeUndefined();
	});

	it("returns only the redacted answer", async () => {
		const outcome = await guardedChat("what is my token?", {
			ask: () => Promise.resolve("your token is SECRET-9"),
			groupId: "hr",
			pipeline: pipelineWith([redactOn("SECRET-9", "[TOKEN]")]),
			userId: "alice",
		});
		expect(outcome.verdict).toBe("redact");
		expect(outcome.answer).toBe("your token is [TOKEN]");
	});

	it("forwards the redacted prompt to the model", async () => {
		const asked: string[] = [];
		const outcome = await guardedChat("remember SECRET-3 for me", {
			ask: (prompt) => {
				asked.push(prompt);
				return Promise.resolve("done");
			},
			groupId: "hr",
			pipeline: pipelineWith([redactOn("SECRET-3", "[TOKEN]")]),
			userId: "alice",
		});
		expect(asked).toEqual(["remember [TOKEN] for me"]);
		expect(outcome.promptVerdict).toBe("redact");
		expect(outcome.verdict).toBe("allow");
		expect(outcome.answer).toBe("done");
	});

	it("audits both directions of the chat interaction", async () => {
		const audit = auditSink();
		await guardedChat("hello", {
			ask: () => Promise.resolve("hi"),
			audit,
			groupId: "hr",
			pipeline: pipelineWith([]),
			userId: "alice",
		});
		const chatEvents = audit.events.filter((event) => event.seam === "chat");
		expect(chatEvents).toHaveLength(2);
		expect(chatEvents.map((event) => event.groupId)).toEqual(["hr", "hr"]);
		expect(chatEvents.map((event) => event.userId)).toEqual(["alice", "alice"]);
	});
});
