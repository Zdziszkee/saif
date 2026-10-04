import { describe, expect, it } from "bun:test";
import {
	consumerKeyOf,
	filterByConsumerKey,
	summarizeByConsumer,
	UNKNOWN_CONSUMER,
} from "#/components/dashboard-consumers.ts";
import { type AuditEvent, auditEvent, summarizeAuditDecisions } from "#/control/audit.ts";

function decision(input: {
	readonly consumerKey?: string;
	readonly controlId?: string;
	readonly groupId?: string;
	readonly kind?: AuditEvent["kind"];
	readonly timestamp: string;
	readonly userId?: string;
	readonly verdict?: AuditEvent["verdict"];
}): AuditEvent {
	const { kind, timestamp, ...fields } = input;
	return { ...auditEvent(kind ?? "interaction", { ...fields }), timestamp };
}

const SEED: readonly AuditEvent[] = [
	decision({
		controlId: "deterministic",
		groupId: "alice",
		timestamp: "2026-03-01T00:00:00.000Z",
		userId: "alice",
		verdict: "allow",
	}),
	decision({
		controlId: "signatures",
		groupId: "alice",
		timestamp: "2026-03-02T00:00:00.000Z",
		userId: "alice",
		verdict: "block",
	}),
	decision({
		controlId: "deterministic",
		groupId: "bob",
		timestamp: "2026-03-03T00:00:00.000Z",
		userId: "bob",
		verdict: "redact",
	}),
	// Noise the per-consumer summary must ignore: a verdict-less note, a
	// registration admission, and a control failure.
	decision({ groupId: "alice", timestamp: "2026-03-04T00:00:00.000Z", userId: "alice" }),
	decision({
		groupId: "bob",
		kind: "registration",
		timestamp: "2026-03-05T00:00:00.000Z",
		userId: "bob",
		verdict: "allow",
	}),
	decision({
		groupId: "alice",
		kind: "failure",
		timestamp: "2026-03-06T00:00:00.000Z",
		userId: "alice",
		verdict: "escalate",
	}),
];

describe("consumerKeyOf", () => {
	it("prefers the dedicated consumerKey over groupId and userId", () => {
		const event = decision({
			consumerKey: "alice-key",
			groupId: "alice",
			timestamp: "2026-03-07T00:00:00.000Z",
			userId: "alice",
			verdict: "allow",
		});
		expect(consumerKeyOf(event)).toBe("alice-key");
	});

	it("falls back to groupId when consumerKey is missing", () => {
		const event = decision({
			groupId: "alice",
			timestamp: "2026-03-07T00:00:00.000Z",
			userId: "alice",
			verdict: "allow",
		});
		expect(consumerKeyOf(event)).toBe("alice");
	});

	it("falls back to groupId when consumerKey is empty", () => {
		const event = decision({
			consumerKey: "",
			groupId: "alice",
			timestamp: "2026-03-07T00:00:00.000Z",
			userId: "alice",
			verdict: "allow",
		});
		expect(consumerKeyOf(event)).toBe("alice");
	});

	it("aggregates distinct users of one group under the groupId", () => {
		const events: readonly AuditEvent[] = [
			decision({
				groupId: "alice",
				timestamp: "2026-03-01T00:00:00.000Z",
				userId: "alice-one",
				verdict: "allow",
			}),
			decision({
				groupId: "alice",
				timestamp: "2026-03-02T00:00:00.000Z",
				userId: "alice-two",
				verdict: "block",
			}),
		];
		expect(summarizeByConsumer(events)).toEqual([["alice", 2]]);
	});

	it("returns the unknown marker when groupId is missing", () => {
		const event = decision({
			timestamp: "2026-03-07T00:00:00.000Z",
			verdict: "allow",
		});
		expect(consumerKeyOf(event)).toBe(UNKNOWN_CONSUMER);
	});

	it("pins the unknown marker text", () => {
		expect(UNKNOWN_CONSUMER).toBe("(none)");
	});
});

describe("filterByConsumerKey", () => {
	it("isolates one consumer without dropping its noise rows", () => {
		const alice = filterByConsumerKey(SEED, "alice");
		expect(alice).toHaveLength(4);
		for (const event of alice) {
			expect(consumerKeyOf(event)).toBe("alice");
		}
	});

	it("matches nothing for an unknown consumer", () => {
		expect(filterByConsumerKey(SEED, "carol")).toEqual([]);
	});

	it("passes everything through when no consumer is selected", () => {
		const all = filterByConsumerKey(SEED, undefined);
		expect(all).toEqual([...SEED]);
		expect(all).not.toBe(SEED);
	});
});

describe("summarizeByConsumer", () => {
	it("counts decisions per consumer, ignoring noise", () => {
		expect(summarizeByConsumer(SEED)).toEqual([
			["alice", 2],
			["bob", 1],
		]);
	});

	it("sorts consumers by decision count descending", () => {
		const skewed: readonly AuditEvent[] = [
			decision({
				groupId: "alice",
				timestamp: "2026-03-01T00:00:00.000Z",
				verdict: "allow",
			}),
			decision({
				groupId: "bob",
				timestamp: "2026-03-02T00:00:00.000Z",
				verdict: "allow",
			}),
			decision({
				groupId: "bob",
				timestamp: "2026-03-03T00:00:00.000Z",
				verdict: "block",
			}),
			decision({
				groupId: "bob",
				timestamp: "2026-03-04T00:00:00.000Z",
				verdict: "redact",
			}),
		];
		expect(summarizeByConsumer(skewed)).toEqual([
			["bob", 3],
			["alice", 1],
		]);
	});

	it("returns empty when nothing is a decision", () => {
		const noise: readonly AuditEvent[] = [
			decision({ groupId: "alice", timestamp: "2026-03-04T00:00:00.000Z" }),
			decision({
				groupId: "bob",
				kind: "registration",
				timestamp: "2026-03-05T00:00:00.000Z",
				verdict: "allow",
			}),
			decision({
				groupId: "alice",
				kind: "failure",
				timestamp: "2026-03-06T00:00:00.000Z",
				verdict: "escalate",
			}),
		];
		expect(summarizeByConsumer(noise)).toEqual([]);
	});
});

describe("per-consumer shaping parity", () => {
	it("mirrors the loader: filter first, then summarize", () => {
		const summary = summarizeAuditDecisions(filterByConsumerKey(SEED, "alice"));
		expect(summary.total).toBe(2);
		expect(summary.byVerdict).toEqual([
			["allow", 1],
			["block", 1],
		]);
		expect(summary.recent).toHaveLength(2);
	});

	it("isolates one consumer without leaking another's decisions", () => {
		const summary = summarizeAuditDecisions(filterByConsumerKey(SEED, "bob"));
		expect(summary.total).toBe(1);
		expect(summary.byControl).toEqual([["deterministic", 1]]);
	});
});
