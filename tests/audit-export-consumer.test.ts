import { describe, expect, it } from "bun:test";
import type { AuditEvent } from "#/control/audit.ts";
import { auditEventsToCsv, auditEventsToJsonl, filterAuditEvents } from "#/control/audit.ts";

function makeEvent(overrides: Partial<AuditEvent> & { timestamp: string }): AuditEvent {
	return { controlId: "deterministic", kind: "interaction", ...overrides };
}

const SEED: readonly AuditEvent[] = [
	makeEvent({
		consumerKey: "alice-key",
		controlId: "deterministic",
		groupId: "alice-key",
		timestamp: "2026-01-01T00:00:00.000Z",
		verdict: "allow",
	}),
	makeEvent({
		consumerKey: "bob-key",
		controlId: "deterministic",
		groupId: "bob-key",
		timestamp: "2026-01-02T00:00:00.000Z",
		verdict: "block",
	}),
	makeEvent({
		consumerKey: "alice-key",
		controlId: "signatures",
		groupId: "alice-key",
		timestamp: "2026-01-03T00:00:00.000Z",
		verdict: "redact",
	}),
	makeEvent({
		consumerKey: "alice-key",
		controlId: "semantic",
		groupId: "shared-topic",
		timestamp: "2026-01-04T00:00:00.000Z",
		verdict: "escalate",
	}),
];

describe("audit export consumer filters", () => {
	it("treats until as an inclusive upper bound", () => {
		const events = filterAuditEvents(SEED, { until: "2026-01-02T00:00:00.000Z" });
		expect(events.map((event) => event.timestamp)).toEqual([
			"2026-01-01T00:00:00.000Z",
			"2026-01-02T00:00:00.000Z",
		]);
	});

	it("narrows to a since/until window", () => {
		const events = filterAuditEvents(SEED, {
			since: "2026-01-02T00:00:00.000Z",
			until: "2026-01-03T00:00:00.000Z",
		});
		expect(events).toHaveLength(2);
	});

	it("combines consumerKey with control", () => {
		const filtered = filterAuditEvents(SEED, {
			consumerKey: "alice-key",
			control: "signatures",
		});
		expect(filtered).toHaveLength(1);
		expect(filtered[0]?.verdict).toBe("redact");
	});

	it("combines consumerKey with verdict", () => {
		const filtered = filterAuditEvents(SEED, {
			consumerKey: "alice-key",
			verdict: "escalate",
		});
		expect(filtered).toHaveLength(1);
		expect(filtered[0]?.controlId).toBe("semantic");
	});

	it("combines consumerKey with groupId", () => {
		const filtered = filterAuditEvents(SEED, {
			consumerKey: "alice-key",
			groupId: "shared-topic",
		});
		expect(filtered).toHaveLength(1);
		expect(filtered[0]?.verdict).toBe("escalate");
	});

	it("matches groupId independently of consumerKey", () => {
		expect(filterAuditEvents(SEED, { groupId: "shared-topic" })).toHaveLength(1);
		expect(filterAuditEvents(SEED, { consumerKey: "shared-topic" })).toHaveLength(0);
	});

	it("combines every dimension at once", () => {
		const filtered = filterAuditEvents(SEED, {
			consumerKey: "alice-key",
			control: "semantic",
			groupId: "shared-topic",
			since: "2026-01-04T00:00:00.000Z",
			until: "2026-01-04T00:00:00.000Z",
			verdict: "escalate",
		});
		expect(filtered).toHaveLength(1);
		expect(filtered[0]?.controlId).toBe("semantic");
	});

	it("round-trips JSONL losslessly", () => {
		const lines = auditEventsToJsonl(SEED).split("\n");
		expect(lines).toHaveLength(SEED.length);
		for (const [index, line] of lines.entries()) {
			expect(JSON.parse(line)).toEqual(SEED[index]);
		}
	});

	it("keeps filtered JSONL and CSV in agreement", () => {
		const filtered = filterAuditEvents(SEED, {
			consumerKey: "alice-key",
			control: "signatures",
		});
		const lines = auditEventsToJsonl(filtered).split("\n");
		const rows = auditEventsToCsv(filtered).split("\n");
		expect(filtered).toHaveLength(1);
		expect(lines).toHaveLength(1);
		expect(rows).toHaveLength(2);
		expect((JSON.parse(lines[0] ?? "") as AuditEvent).consumerKey).toBe("alice-key");
		expect(rows[1]).toContain("alice-key");
	});
});

const PERSON_SEED: readonly AuditEvent[] = [
	makeEvent({
		consumerKey: "key-1",
		controlId: "deterministic",
		groupId: "analyst",
		timestamp: "2026-02-01T00:00:00.000Z",
		userId: "alice",
		verdict: "allow",
	}),
	makeEvent({
		consumerKey: "key-1",
		controlId: "signatures",
		groupId: "viewer",
		timestamp: "2026-02-02T00:00:00.000Z",
		userId: "alice",
		verdict: "block",
	}),
	makeEvent({
		consumerKey: "key-2",
		controlId: "deterministic",
		groupId: "analyst",
		timestamp: "2026-02-03T00:00:00.000Z",
		userId: "bob",
		verdict: "allow",
	}),
	makeEvent({
		consumerKey: "key-2",
		controlId: "semantic",
		groupId: "analyst",
		timestamp: "2026-02-04T00:00:00.000Z",
		userId: "carol",
		verdict: "redact",
	}),
];

describe("audit export person (userId) and role (groupId) filters", () => {
	it("scopes to a person across roles via userId", () => {
		const filtered = filterAuditEvents(PERSON_SEED, { userId: "alice" });
		expect(filtered).toHaveLength(2);
		expect(filtered.map((event) => event.groupId)).toEqual(["analyst", "viewer"]);
	});

	it("keeps the person dimension distinct from the raw consumer key", () => {
		expect(filterAuditEvents(PERSON_SEED, { consumerKey: "alice" })).toHaveLength(0);
		expect(filterAuditEvents(PERSON_SEED, { consumerKey: "key-1" })).toHaveLength(2);
		expect(filterAuditEvents(PERSON_SEED, { consumerKey: "key-1", userId: "alice" })).toHaveLength(
			2,
		);
		expect(filterAuditEvents(PERSON_SEED, { consumerKey: "key-2", userId: "alice" })).toHaveLength(
			0,
		);
	});

	it("scopes to a role across people via groupId", () => {
		const filtered = filterAuditEvents(PERSON_SEED, { groupId: "analyst" });
		expect(filtered).toHaveLength(3);
		expect(filtered.map((event) => event.userId)).toEqual(["alice", "bob", "carol"]);
	});

	it("combines person and role to a single intersection", () => {
		const filtered = filterAuditEvents(PERSON_SEED, { groupId: "analyst", userId: "alice" });
		expect(filtered).toHaveLength(1);
		expect(filtered[0]?.verdict).toBe("allow");
	});

	it("keeps person attribution through the JSONL export encoding", () => {
		const filtered = filterAuditEvents(PERSON_SEED, { groupId: "analyst", userId: "bob" });
		const lines = auditEventsToJsonl(filtered).split("\n");
		expect(lines).toHaveLength(1);
		expect((JSON.parse(lines[0] ?? "") as AuditEvent).userId).toBe("bob");
	});
});
