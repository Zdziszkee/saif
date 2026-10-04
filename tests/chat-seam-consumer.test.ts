import { describe, expect, it } from "bun:test";

import { createInMemoryAuditSink, readAuditEvents } from "#/control/audit.ts";
import { guardedChat } from "#/control/chat.ts";
import type { ControlPipeline, Interaction } from "#/control/types.ts";
import { blockOn, pipelineWith } from "./helpers/fixtures.ts";

/**
 * Chat-seam identity attribution: `guardedChat` takes `{ groupId, userId }`
 * and threads both onto the inbound-prompt and outbound-answer interactions,
 * so every chat audit event carries the calling `userId` and `groupId`.
 *
 * The seam also passes the legacy `consumerKey` compat field to
 * `guardInteraction` as `userId ?? "(none)"` (same convention as the guard
 * API), so per-user reporting over the chat seam can read either `userId`
 * or `consumerKey`; these tests fail if either side of that contract changes.
 */

const alice = { groupId: "hr", userId: "alice" };
const bob = { groupId: "manager", userId: "bob" };

describe("chat seam identity attribution", () => {
	it("threads userId and groupId onto both chat directions", async () => {
		const sink = createInMemoryAuditSink();
		const seen: Interaction[] = [];
		const inner = pipelineWith([]);
		const spy: ControlPipeline = {
			inspect: (interaction) => {
				seen.push(interaction);
				return inner.inspect(interaction);
			},
		};

		const outcome = await guardedChat("hello", {
			ask: () => Promise.resolve("hi"),
			audit: sink,
			groupId: alice.groupId,
			pipeline: spy,
			userId: alice.userId,
		});

		expect(outcome.verdict).toBe("allow");
		expect(outcome.answer).toBe("hi");
		expect(seen).toHaveLength(2);
		for (const interaction of seen) {
			expect(interaction.groupId).toBe("hr");
			expect(interaction.userId).toBe("alice");
		}
		const events = readAuditEvents(sink).filter((event) => event.seam === "chat");
		expect(events).toHaveLength(2);
		for (const event of events) {
			expect(event.groupId).toBe("hr");
			expect(event.userId).toBe("alice");
			expect(event.consumerKey).toBe("alice");
		}
	});

	it("attributes a blocked prompt to the caller without asking the model", async () => {
		const sink = createInMemoryAuditSink();
		const asked: string[] = [];

		const outcome = await guardedChat("EVIL inside", {
			ask: (prompt) => {
				asked.push(prompt);
				return Promise.resolve("hi");
			},
			audit: sink,
			groupId: alice.groupId,
			pipeline: pipelineWith([blockOn("EVIL")]),
			userId: alice.userId,
		});

		expect(outcome.verdict).toBe("block");
		expect(asked).toHaveLength(0);
		const events = readAuditEvents(sink);
		expect(events).toHaveLength(1);
		expect(events[0]?.groupId).toBe("hr");
		expect(events[0]?.userId).toBe("alice");
		expect(events[0]?.consumerKey).toBe("alice");
		expect(events[0]?.verdict).toBe("block");
	});

	it("attributes the outbound answer direction to the caller", async () => {
		const sink = createInMemoryAuditSink();

		const outcome = await guardedChat("hello", {
			ask: () => Promise.resolve("an EVIL answer"),
			audit: sink,
			groupId: alice.groupId,
			pipeline: pipelineWith([blockOn("EVIL", "fixture-block", "outbound")]),
			userId: alice.userId,
		});

		expect(outcome.promptVerdict).toBe("allow");
		expect(outcome.verdict).toBe("block");
		expect(outcome.answer).toBeUndefined();
		const events = readAuditEvents(sink).filter((event) => event.seam === "chat");
		expect(events).toHaveLength(2);
		for (const event of events) {
			expect(event.groupId).toBe("hr");
			expect(event.userId).toBe("alice");
			expect(event.consumerKey).toBe("alice");
		}
		expect(events.at(-1)?.verdict).toBe("block");
	});

	it("distinguishes callers by consumerKey per userId", async () => {
		const aliceSink = createInMemoryAuditSink();
		const bobSink = createInMemoryAuditSink();

		await guardedChat("hello", {
			ask: () => Promise.resolve("hi"),
			audit: aliceSink,
			groupId: alice.groupId,
			pipeline: pipelineWith([]),
			userId: alice.userId,
		});
		await guardedChat("hello", {
			ask: () => Promise.resolve("hi"),
			audit: bobSink,
			groupId: bob.groupId,
			pipeline: pipelineWith([]),
			userId: bob.userId,
		});

		const aliceEvents = readAuditEvents(aliceSink);
		const bobEvents = readAuditEvents(bobSink);
		expect(aliceEvents).toHaveLength(2);
		expect(bobEvents).toHaveLength(2);
		for (const event of aliceEvents) {
			expect(event.userId).toBe("alice");
			expect(event.groupId).toBe("hr");
			expect(event.consumerKey).toBe("alice");
		}
		for (const event of bobEvents) {
			expect(event.userId).toBe("bob");
			expect(event.groupId).toBe("manager");
			expect(event.consumerKey).toBe("bob");
		}
	});

	it("falls back to the (none) consumerKey when userId is absent", async () => {
		const sink = createInMemoryAuditSink();

		const outcome = await guardedChat("hello", {
			ask: () => Promise.resolve("hi"),
			audit: sink,
			groupId: "hr",
			pipeline: pipelineWith([]),
			userId: undefined as unknown as string,
		});

		expect(outcome.verdict).toBe("allow");
		const events = readAuditEvents(sink).filter((event) => event.seam === "chat");
		expect(events).toHaveLength(2);
		for (const event of events) {
			expect(event.consumerKey).toBe("(none)");
		}
	});
});
