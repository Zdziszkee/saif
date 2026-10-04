import { describe, expect, it } from "bun:test";

import { createInMemoryAuditSink, readAuditEvents } from "#/control/audit.ts";
import { guardInteraction } from "#/control/guard.ts";
import { handleGuardRequest } from "#/control/guard-api.ts";
import { CONSUMER_KEY_HEADER, createConsumerResolver } from "#/control/subjects.ts";
import type { ControlPipeline, Interaction } from "#/control/types.ts";

/**
 * Guard consumer-key propagation: every `handleGuardRequest` outcome is
 * recorded against the raw consumer key (`"(none)"` when absent) with the
 * resolved policy subject alongside it. Known keys govern as a subject of the
 * same name; missing/unknown keys follow the policy's default-subject or
 * reject behavior. `guardInteraction` defaults an absent key to `"(none)"`.
 */

const envelope = { content: "hello world", direction: "inbound", seam: "guard-api" };

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

function guardRequest(body: unknown, consumerKey?: string): Request {
	const headers = new Headers({ "content-type": "application/json" });
	if (consumerKey !== undefined) {
		headers.set(CONSUMER_KEY_HEADER, consumerKey);
	}
	return new Request("http://test.local/api/guard", {
		body: JSON.stringify(body),
		headers,
		method: "POST",
	});
}

describe("guard consumer-key recording", () => {
	it("known key records consumerKey and subject", async () => {
		const sink = createInMemoryAuditSink();
		const seen: Interaction[] = [];
		const spy: ControlPipeline = {
			inspect: (interaction) => {
				seen.push(interaction);
				return allowPipeline.inspect(interaction);
			},
		};

		const response = await handleGuardRequest(guardRequest(envelope, "alice"), {
			audit: sink,
			consumers: createConsumerResolver({
				defaultSubject: "default",
				knownKeys: ["alice", "bob"],
				unknownKey: "default-subject",
			}),
			pipeline: spy,
		});

		expect(response.status).toBe(200);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.subject).toBe("alice");
		const decisions = readAuditEvents(sink).filter(
			(event) => event.kind === "interaction" && event.verdict !== undefined,
		);
		expect(decisions).toHaveLength(1);
		expect(decisions[0]?.consumerKey).toBe("alice");
		expect(decisions[0]?.subject).toBe("alice");
	});

	it("unknown key falls back to default subject with presented key", async () => {
		const sink = createInMemoryAuditSink();

		const response = await handleGuardRequest(guardRequest(envelope, "ghost"), {
			audit: sink,
			consumers: createConsumerResolver({
				defaultSubject: "default",
				knownKeys: ["alice", "bob"],
				unknownKey: "default-subject",
			}),
			pipeline: allowPipeline,
		});

		expect(response.status).toBe(200);
		const events = readAuditEvents(sink);
		const note = events.find((event) => event.detail?.includes("resolved to default subject"));
		expect(note?.consumerKey).toBe("ghost");
		expect(note?.subject).toBe("default");
		const decisions = events.filter(
			(event) => event.kind === "interaction" && event.verdict !== undefined,
		);
		expect(decisions).toHaveLength(1);
		expect(decisions[0]?.consumerKey).toBe("ghost");
		expect(decisions[0]?.subject).toBe("default");
	});

	it("missing key records (none) under the default subject", async () => {
		const sink = createInMemoryAuditSink();

		const response = await handleGuardRequest(guardRequest(envelope), {
			audit: sink,
			consumers: createConsumerResolver({
				defaultSubject: "default",
				knownKeys: ["alice", "bob"],
				unknownKey: "default-subject",
			}),
			pipeline: allowPipeline,
		});

		expect(response.status).toBe(200);
		const events = readAuditEvents(sink);
		const note = events.find((event) => event.detail?.includes("resolved to default subject"));
		expect(note?.consumerKey).toBe("(none)");
		expect(note?.subject).toBe("default");
		const decisions = events.filter(
			(event) => event.kind === "interaction" && event.verdict !== undefined,
		);
		expect(decisions).toHaveLength(1);
		expect(decisions[0]?.consumerKey).toBe("(none)");
		expect(decisions[0]?.subject).toBe("default");
	});

	it("reject policy blocks unknown key without invoking pipeline", async () => {
		const sink = createInMemoryAuditSink();
		const seen: Interaction[] = [];
		const spy: ControlPipeline = {
			inspect: (interaction) => {
				seen.push(interaction);
				return allowPipeline.inspect(interaction);
			},
		};

		const response = await handleGuardRequest(guardRequest(envelope, "ghost"), {
			audit: sink,
			consumers: createConsumerResolver({
				defaultSubject: "default",
				knownKeys: ["alice", "bob"],
				unknownKey: "reject",
			}),
			pipeline: spy,
		});

		expect(response.status).toBe(403);
		expect(seen).toHaveLength(0);
		const events = readAuditEvents(sink);
		expect(events).toHaveLength(1);
		expect(events[0]?.consumerKey).toBe("ghost");
		expect(events[0]?.controlId).toBe("consumer-key");
		expect(events[0]?.verdict).toBe("block");
	});

	it("reject policy blocks missing key without invoking pipeline", async () => {
		const sink = createInMemoryAuditSink();
		const seen: Interaction[] = [];
		const spy: ControlPipeline = {
			inspect: (interaction) => {
				seen.push(interaction);
				return allowPipeline.inspect(interaction);
			},
		};

		const response = await handleGuardRequest(guardRequest(envelope), {
			audit: sink,
			consumers: createConsumerResolver({
				defaultSubject: "default",
				knownKeys: ["alice", "bob"],
				unknownKey: "reject",
			}),
			pipeline: spy,
		});

		expect(response.status).toBe(403);
		expect(seen).toHaveLength(0);
		const events = readAuditEvents(sink);
		expect(events).toHaveLength(1);
		expect(events[0]?.consumerKey).toBe("(none)");
		expect(events[0]?.controlId).toBe("consumer-key");
		expect(events[0]?.verdict).toBe("block");
	});

	it("malformed request records consumerKey without invoking pipeline", async () => {
		const sink = createInMemoryAuditSink();
		const seen: Interaction[] = [];
		const spy: ControlPipeline = {
			inspect: (interaction) => {
				seen.push(interaction);
				return allowPipeline.inspect(interaction);
			},
		};

		const response = await handleGuardRequest(guardRequest({ direction: "inbound" }, "bob"), {
			audit: sink,
			consumers: createConsumerResolver({
				defaultSubject: "default",
				knownKeys: ["alice", "bob"],
				unknownKey: "default-subject",
			}),
			pipeline: spy,
		});

		expect(response.status).toBe(400);
		expect(seen).toHaveLength(0);
		const events = readAuditEvents(sink);
		expect(events).toHaveLength(1);
		expect(events[0]?.consumerKey).toBe("bob");
		expect(events[0]?.subject).toBe("bob");
		expect(events[0]?.verdict).toBeUndefined();
	});

	it("malformed request with missing key records (none) without invoking pipeline", async () => {
		const sink = createInMemoryAuditSink();
		const seen: Interaction[] = [];
		const spy: ControlPipeline = {
			inspect: (interaction) => {
				seen.push(interaction);
				return allowPipeline.inspect(interaction);
			},
		};

		const response = await handleGuardRequest(guardRequest({ direction: "inbound" }), {
			audit: sink,
			consumers: createConsumerResolver({
				defaultSubject: "default",
				knownKeys: ["alice", "bob"],
				unknownKey: "default-subject",
			}),
			pipeline: spy,
		});

		expect(response.status).toBe(400);
		expect(seen).toHaveLength(0);
		const events = readAuditEvents(sink);
		expect(events).toHaveLength(2);
		for (const event of events) {
			expect(event.consumerKey).toBe("(none)");
			expect(event.subject).toBe("default");
			expect(event.verdict).toBeUndefined();
		}
	});
});

describe("guardInteraction consumerKey", () => {
	it("defaults absent consumerKey to (none)", async () => {
		const sink = createInMemoryAuditSink();

		await guardInteraction(
			{
				content: "hello",
				direction: "inbound",
				id: "int_1",
				seam: "guard-api",
				subject: "alice",
			},
			allowPipeline,
			{ audit: sink },
		);

		const events = readAuditEvents(sink);
		expect(events).toHaveLength(1);
		expect(events[0]?.consumerKey).toBe("(none)");
		expect(events[0]?.subject).toBe("alice");
	});

	it("records explicit consumerKey", async () => {
		const sink = createInMemoryAuditSink();

		await guardInteraction(
			{
				content: "hello",
				direction: "inbound",
				id: "int_1",
				seam: "guard-api",
				subject: "alice",
			},
			allowPipeline,
			{ audit: sink, consumerKey: "alice" },
		);

		const events = readAuditEvents(sink);
		expect(events).toHaveLength(1);
		expect(events[0]?.consumerKey).toBe("alice");
		expect(events[0]?.subject).toBe("alice");
	});
});

describe("consumer resolver mapping (mcp route equivalent)", () => {
	it("default-subject policy maps unknown and missing to default", () => {
		const resolver = createConsumerResolver({
			defaultSubject: "default",
			knownKeys: ["alice"],
			unknownKey: "default-subject",
		});

		const known = resolver.resolve("alice");
		expect(known).toEqual({ key: "alice", kind: "known", ok: true, subject: "alice" });
		const unknown = resolver.resolve("ghost");
		expect(unknown).toEqual({
			key: "ghost",
			kind: "default-subject",
			ok: true,
			subject: "default",
		});
		const missing = resolver.resolve(undefined);
		expect(missing).toEqual({
			key: undefined,
			kind: "default-subject",
			ok: true,
			subject: "default",
		});
	});

	it("reject policy rejects unknown and missing keys", () => {
		const resolver = createConsumerResolver({
			defaultSubject: "default",
			knownKeys: ["alice"],
			unknownKey: "reject",
		});

		const unknown = resolver.resolve("ghost");
		expect(unknown.ok).toBe(false);
		const missing = resolver.resolve(undefined);
		expect(missing.ok).toBe(false);
	});
});
