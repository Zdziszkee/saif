import { describe, expect, it } from "bun:test";

import { createInMemoryAuditSink, readAuditEvents } from "#/control/audit.ts";
import { guardedChat } from "#/control/chat.ts";
import type { ControlPipeline, Interaction } from "#/control/types.ts";

/**
 * Chat-seam consumer-key gap: `guardedChat` has no consumer-key channel and
 * calls `guardInteraction` without one, so every chat audit records
 * `"(none)"` even when the subject is known. These tests document the current
 * unattributed behavior; they fail if attribution is added.
 */

const allowPipeline: ControlPipeline = {
	inspect: (interaction: Interaction) =>
		Promise.resolve({
			content: interaction.content,
			flagged: false,
			hits: [],
			redactions: [],
			verdict: "allow",
		}),
};

const blockPipeline: ControlPipeline = {
	inspect: (interaction: Interaction) =>
		Promise.resolve({
			blockingControl: "fixture-block",
			content: interaction.content,
			flagged: false,
			hits: [{ controlId: "fixture-block", kind: "fixture", verdict: "block" }],
			redactions: [],
			verdict: "block",
		}),
};

describe("chat seam consumerKey gap", () => {
	it("allow records (none) consumerKey despite known subject", async () => {
		const sink = createInMemoryAuditSink();

		const outcome = await guardedChat("hello", {
			ask: () => Promise.resolve("hi"),
			audit: sink,
			pipeline: allowPipeline,
			subject: "alice",
		});

		expect(outcome.verdict).toBe("allow");
		const events = readAuditEvents(sink).filter((event) => event.seam === "chat");
		expect(events).toHaveLength(2);
		for (const event of events) {
			expect(event.consumerKey).toBe("(none)");
			expect(event.subject).toBe("alice");
		}
	});

	it("block records (none) consumerKey without asking the model", async () => {
		const sink = createInMemoryAuditSink();
		const asked: string[] = [];

		const outcome = await guardedChat("hello", {
			ask: (prompt) => {
				asked.push(prompt);
				return Promise.resolve("hi");
			},
			audit: sink,
			pipeline: blockPipeline,
			subject: "alice",
		});

		expect(outcome.verdict).toBe("block");
		expect(asked).toHaveLength(0);
		const events = readAuditEvents(sink);
		expect(events).toHaveLength(1);
		expect(events[0]?.consumerKey).toBe("(none)");
		expect(events[0]?.subject).toBe("alice");
		expect(events[0]?.verdict).toBe("block");
	});

	it("cannot distinguish consumers by consumerKey", async () => {
		const aliceSink = createInMemoryAuditSink();
		const bobSink = createInMemoryAuditSink();

		await guardedChat("hello", {
			ask: () => Promise.resolve("hi"),
			audit: aliceSink,
			pipeline: allowPipeline,
			subject: "alice",
		});
		await guardedChat("hello", {
			ask: () => Promise.resolve("hi"),
			audit: bobSink,
			pipeline: allowPipeline,
			subject: "bob",
		});

		const aliceKeys = readAuditEvents(aliceSink).map((event) => event.consumerKey);
		const bobKeys = readAuditEvents(bobSink).map((event) => event.consumerKey);
		expect(aliceKeys).toEqual(["(none)", "(none)"]);
		expect(bobKeys).toEqual(["(none)", "(none)"]);
	});
});
