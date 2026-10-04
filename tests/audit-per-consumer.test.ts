import { describe, expect, test } from "bun:test";
import type { AuditEvent, AuditSink } from "#/control/audit.ts";
import {
	auditEvent,
	auditEventsToCsv,
	auditEventsToJsonl,
	createInMemoryAuditSink,
	filterAuditEvents,
	isAuditDecision,
	noopAuditSink,
	readAuditEvents,
	summarizeAuditDecisions,
} from "#/control/audit.ts";

const seed: AuditEvent[] = [
	{
		consumerKey: "alice-key",
		controlId: "deterministic",
		groupId: "alice-key",
		kind: "interaction",
		timestamp: "2026-01-01T00:00:00.000Z",
		verdict: "allow",
	},
	{
		consumerKey: "bob-key",
		controlId: "deterministic",
		groupId: "bob-key",
		kind: "interaction",
		timestamp: "2026-01-02T00:00:00.000Z",
		verdict: "block",
	},
	{
		consumerKey: "carol-key",
		controlId: "signatures",
		groupId: "carol-key",
		kind: "interaction",
		timestamp: "2026-01-03T00:00:00.000Z",
		verdict: "redact",
	},
	{
		// No consumer key presented: groupId falls back to the policy default
		// while consumerKey stays missing.
		controlId: "deterministic",
		groupId: "default",
		kind: "interaction",
		timestamp: "2026-01-04T00:00:00.000Z",
		verdict: "allow",
	},
	{
		consumerKey: "alice-key",
		controlId: "signatures",
		groupId: "alice-key",
		kind: "interaction",
		timestamp: "2026-01-05T00:00:00.000Z",
		verdict: "escalate",
	},
	{
		// Verdict-less note: visible to raw filters, excluded from summaries.
		consumerKey: "alice-key",
		groupId: "alice-key",
		kind: "interaction",
		timestamp: "2026-01-06T00:00:00.000Z",
	},
	{
		// Non-interaction history: carries a verdict but is not a decision.
		consumerKey: "bob-key",
		controlId: "deterministic",
		groupId: "bob-key",
		kind: "registration",
		timestamp: "2026-01-07T00:00:00.000Z",
		verdict: "allow",
	},
];

describe("auditEvent", () => {
	test("builds an event with the given kind and fields", () => {
		// Arrange
		const fields = { consumerKey: "alice-key", verdict: "allow" } as const;

		// Act
		const event = auditEvent("interaction", fields);

		// Assert
		expect(event.kind).toBe("interaction");
		expect(event.consumerKey).toBe("alice-key");
		expect(event.verdict).toBe("allow");
		expect(Number.isNaN(Date.parse(event.timestamp))).toBe(false);
	});

	test("defaults to empty fields with a timestamp", () => {
		// Arrange
		const kind = "budget" as const;

		// Act
		const event = auditEvent(kind);

		// Assert
		expect(event.kind).toBe("budget");
		expect(event.consumerKey).toBeUndefined();
		expect(Number.isNaN(Date.parse(event.timestamp))).toBe(false);
	});
});

describe("createInMemoryAuditSink", () => {
	test("starts empty", () => {
		// Arrange
		// Act
		const sink = createInMemoryAuditSink();

		// Assert
		expect(sink.events).toHaveLength(0);
	});

	test("appends records in order", () => {
		// Arrange
		const sink = createInMemoryAuditSink();
		const first: AuditEvent = {
			kind: "interaction",
			timestamp: "2026-01-01T00:00:00.000Z",
			verdict: "allow",
		};
		const second: AuditEvent = {
			kind: "interaction",
			timestamp: "2026-01-02T00:00:00.000Z",
			verdict: "block",
		};

		// Act
		sink.record(first);
		sink.record(second);

		// Assert
		expect(sink.events).toHaveLength(2);
		expect(sink.events[0]).toBe(first);
		expect(sink.events[1]).toBe(second);
	});
});

describe("readAuditEvents", () => {
	test("reads recorded events from the in-memory sink", () => {
		// Arrange
		const sink = createInMemoryAuditSink();
		for (const event of seed) {
			sink.record(event);
		}

		// Act
		const events = readAuditEvents(sink);

		// Assert
		expect(events).toHaveLength(7);
		expect(events).toEqual(seed);
	});

	test("returns empty for the noop sink", () => {
		// Arrange
		// Act
		const events = readAuditEvents(noopAuditSink);

		// Assert
		expect(events).toEqual([]);
	});

	test("returns empty when the sink exposes no events array", () => {
		// Arrange
		// Act
		const events = readAuditEvents({ record: () => undefined });

		// Assert
		expect(events).toEqual([]);
	});

	test("returns empty when exposed events is not an array", () => {
		// Arrange
		const odd = { events: "not-an-array", record: () => undefined } as unknown as AuditSink;

		// Act
		const events = readAuditEvents(odd);

		// Assert
		expect(events).toEqual([]);
	});
});

describe("isAuditDecision", () => {
	test("treats an interaction with a verdict as a decision", () => {
		// Arrange
		// Act
		const decision = isAuditDecision({ kind: "interaction", verdict: "allow" });

		// Assert
		expect(decision).toBe(true);
	});

	test("rejects verdict-less interactions", () => {
		// Arrange
		// Act
		const decision = isAuditDecision({ kind: "interaction" });

		// Assert
		expect(decision).toBe(false);
	});

	test("rejects registrations carrying a verdict", () => {
		// Arrange
		// Act
		const decision = isAuditDecision({ kind: "registration", verdict: "allow" });

		// Assert
		expect(decision).toBe(false);
	});

	test("rejects failures carrying a verdict", () => {
		// Arrange
		// Act
		const decision = isAuditDecision({ kind: "failure", verdict: "block" });

		// Assert
		expect(decision).toBe(false);
	});
});

describe("filterAuditEvents", () => {
	const consumerCases = [
		{ consumerKey: "alice-key", count: 3 },
		{ consumerKey: "bob-key", count: 2 },
		{ consumerKey: "carol-key", count: 1 },
		{ consumerKey: "unknown-key", count: 0 },
	] as const;
	for (const { consumerKey, count } of consumerCases) {
		test(`filters decisions by exact consumerKey "${consumerKey}"`, () => {
			// Arrange
			const filter = { consumerKey };

			// Act
			const filtered = filterAuditEvents(seed, filter);

			// Assert
			expect(filtered).toHaveLength(count);
			for (const event of filtered) {
				expect(event.consumerKey).toBe(consumerKey);
			}
		});
	}

	const verdictCases = [
		{ count: 3, verdict: "allow" },
		{ count: 1, verdict: "block" },
		{ count: 1, verdict: "escalate" },
		{ count: 1, verdict: "redact" },
	] as const;
	for (const { count, verdict } of verdictCases) {
		test(`filters decisions by verdict "${verdict}"`, () => {
			// Arrange
			const filter = { verdict };

			// Act
			const filtered = filterAuditEvents(seed, filter);

			// Assert
			expect(filtered).toHaveLength(count);
			for (const event of filtered) {
				expect(event.verdict).toBe(verdict);
			}
		});
	}

	test("filters decisions by control", () => {
		// Arrange
		const filter = { control: "signatures" };

		// Act
		const filtered = filterAuditEvents(seed, filter);

		// Assert
		expect(filtered).toHaveLength(2);
		for (const event of filtered) {
			expect(event.controlId).toBe("signatures");
		}
	});

	test("filters decisions by groupId", () => {
		// Arrange
		const filter = { groupId: "carol-key" };

		// Act
		const filtered = filterAuditEvents(seed, filter);

		// Assert
		expect(filtered).toHaveLength(1);
		expect(filtered[0]?.consumerKey).toBe("carol-key");
	});

	test("treats since as an inclusive lower bound", () => {
		// Arrange
		const filter = { since: "2026-01-05T00:00:00.000Z" };

		// Act
		const filtered = filterAuditEvents(seed, filter);

		// Assert
		expect(filtered.map((event) => event.timestamp)).toEqual([
			"2026-01-05T00:00:00.000Z",
			"2026-01-06T00:00:00.000Z",
			"2026-01-07T00:00:00.000Z",
		]);
	});

	test("treats until as an inclusive upper bound", () => {
		// Arrange
		const filter = { until: "2026-01-01T00:00:00.000Z" };

		// Act
		const filtered = filterAuditEvents(seed, filter);

		// Assert
		expect(filtered).toHaveLength(1);
		expect(filtered[0]?.consumerKey).toBe("alice-key");
	});

	test("combines consumerKey with until", () => {
		// Arrange
		const filter = { consumerKey: "alice-key", until: "2026-01-01T00:00:00.000Z" };

		// Act
		const filtered = filterAuditEvents(seed, filter);

		// Assert
		expect(filtered).toHaveLength(1);
		expect(filtered[0]?.verdict).toBe("allow");
	});

	test("returns everything for an empty filter", () => {
		// Arrange
		// Act
		const filtered = filterAuditEvents(seed, {});

		// Assert
		expect(filtered).toHaveLength(7);
	});

	test("leaves the input array untouched when filtering", () => {
		// Arrange
		const before = [...seed];

		// Act
		filterAuditEvents(seed, { consumerKey: "alice-key" });

		// Assert
		expect(seed).toEqual(before);
	});
});

describe("summarizeAuditDecisions", () => {
	test("counts decisions only in total", () => {
		// Arrange
		// Act
		const summary = summarizeAuditDecisions(seed);

		// Assert
		expect(summary.total).toBe(5);
	});

	test("groups decisions by consumer with missing keys under none", () => {
		// Arrange
		// Act
		const summary = summarizeAuditDecisions(seed);

		// Assert
		// Current behavior labels a missing key "none" (not "(none)").
		expect(summary.byConsumer).toEqual([
			["alice-key", 2],
			["bob-key", 1],
			["carol-key", 1],
			["none", 1],
		]);
	});

	test("groups decisions by control", () => {
		// Arrange
		// Act
		const summary = summarizeAuditDecisions(seed);

		// Assert
		expect(summary.byControl).toEqual([
			["deterministic", 3],
			["signatures", 2],
		]);
	});

	test("groups decisions by verdict", () => {
		// Arrange
		// Act
		const summary = summarizeAuditDecisions(seed);

		// Assert
		expect(summary.byVerdict).toEqual([
			["allow", 2],
			["block", 1],
			["redact", 1],
			["escalate", 1],
		]);
	});

	test("lists recent decisions newest first", () => {
		// Arrange
		// Act
		const summary = summarizeAuditDecisions(seed);

		// Assert
		expect(summary.recent.map((event) => event.timestamp)).toEqual([
			"2026-01-05T00:00:00.000Z",
			"2026-01-04T00:00:00.000Z",
			"2026-01-03T00:00:00.000Z",
			"2026-01-02T00:00:00.000Z",
			"2026-01-01T00:00:00.000Z",
		]);
	});

	test("honors the recent limit keeping total", () => {
		// Arrange
		// Act
		const summary = summarizeAuditDecisions(seed, 2);

		// Assert
		expect(summary.total).toBe(5);
		expect(summary.recent.map((event) => event.timestamp)).toEqual([
			"2026-01-05T00:00:00.000Z",
			"2026-01-04T00:00:00.000Z",
		]);
	});

	test("excludes verdict-less and non-interaction noise from recent", () => {
		// Arrange
		// Act
		const summary = summarizeAuditDecisions(seed);

		// Assert
		expect(summary.recent).toHaveLength(5);
		for (const event of summary.recent) {
			expect(isAuditDecision(event)).toBe(true);
		}
	});

	test("keeps policy group separate from the raw consumer key", () => {
		// Arrange
		// Act
		const keyless = seed.at(3);

		// Assert
		expect(keyless?.consumerKey).toBeUndefined();
		expect(keyless?.groupId).toBe("default");
	});
});

describe("auditEventsToJsonl", () => {
	test("emits one JSON object per line", () => {
		// Arrange
		// Act
		const lines = auditEventsToJsonl(seed).split("\n");

		// Assert
		expect(lines).toHaveLength(7);
		for (const line of lines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
	});

	test("round-trips consumerKey values including the missing key", () => {
		// Arrange
		// Act
		const lines = auditEventsToJsonl(seed).split("\n");

		// Assert
		const parsed = lines.map((line) => JSON.parse(line) as AuditEvent);
		expect(parsed.map((event) => event.consumerKey)).toEqual([
			"alice-key",
			"bob-key",
			"carol-key",
			undefined,
			"alice-key",
			"alice-key",
			"bob-key",
		]);
	});
});

describe("auditEventsToCsv", () => {
	test("emits the header row with the consumerKey column", () => {
		// Arrange
		// Act
		const rows = auditEventsToCsv(seed).split("\n");

		// Assert
		expect(rows[0]).toBe(
			"timestamp,kind,verdict,controlId,groupId,consumerKey,seam,interactionId,detail,redactionCount",
		);
		expect(rows).toHaveLength(8);
	});

	test("places each consumerKey in its row", () => {
		// Arrange
		// Act
		const rows = auditEventsToCsv(seed).split("\n");

		// Assert
		expect(rows[1]).toContain("alice-key");
		expect(rows[2]).toContain("bob-key");
		expect(rows[3]).toContain("carol-key");
	});

	test("leaves the consumerKey cell empty when no key was presented", () => {
		// Arrange
		// Act
		const rows = auditEventsToCsv(seed).split("\n");

		// Assert
		expect(rows[4]?.split(",").at(5)).toBe("");
	});

	test("quotes details containing commas and quotes", () => {
		// Arrange
		const event: AuditEvent = {
			consumerKey: "alice-key",
			detail: 'hello, "world"',
			kind: "interaction",
			timestamp: "2026-01-08T00:00:00.000Z",
		};

		// Act
		const rows = auditEventsToCsv([event]).split("\n");

		// Assert
		expect(rows[1]).toBe('2026-01-08T00:00:00.000Z,interaction,,,,alice-key,,,"hello, ""world""",');
	});
});
