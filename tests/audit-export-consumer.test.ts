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
		subject: "alice-key",
		timestamp: "2026-01-01T00:00:00.000Z",
		verdict: "allow",
	}),
	makeEvent({
		consumerKey: "bob-key",
		controlId: "deterministic",
		subject: "bob-key",
		timestamp: "2026-01-02T00:00:00.000Z",
		verdict: "block",
	}),
	makeEvent({
		consumerKey: "alice-key",
		controlId: "signatures",
		subject: "alice-key",
		timestamp: "2026-01-03T00:00:00.000Z",
		verdict: "redact",
	}),
	makeEvent({
		consumerKey: "alice-key",
		controlId: "semantic",
		subject: "shared-topic",
		timestamp: "2026-01-04T00:00:00.000Z",
		verdict: "escalate",
	}),
];

const EXPECTED_HEADER =
	"timestamp,kind,verdict,controlId,subject,consumerKey,seam,interactionId,detail,redactionCount";

describe("audit export consumer filters", () => {
	it("filters by consumerKey", () => {
		const alice = filterAuditEvents(SEED, { consumerKey: "alice-key" });
		expect(alice).toHaveLength(3);
		for (const event of alice) {
			expect(event.consumerKey).toBe("alice-key");
		}
	});

	it("matches nothing for an unknown consumerKey", () => {
		expect(filterAuditEvents(SEED, { consumerKey: "nobody" })).toEqual([]);
	});

	it("returns everything when the filter is empty", () => {
		expect(filterAuditEvents(SEED, {})).toHaveLength(SEED.length);
	});

	it("treats since as an inclusive lower bound", () => {
		const events = filterAuditEvents(SEED, { since: "2026-01-02T00:00:00.000Z" });
		expect(events.map((event) => event.timestamp)).toEqual([
			"2026-01-02T00:00:00.000Z",
			"2026-01-03T00:00:00.000Z",
			"2026-01-04T00:00:00.000Z",
		]);
	});

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

	it("combines consumerKey with the time window", () => {
		const aliceEarly = filterAuditEvents(SEED, {
			consumerKey: "alice-key",
			until: "2026-01-01T00:00:00.000Z",
		});
		expect(aliceEarly).toHaveLength(1);
		expect(aliceEarly[0]?.verdict).toBe("allow");
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

	it("combines consumerKey with subject", () => {
		const filtered = filterAuditEvents(SEED, {
			consumerKey: "alice-key",
			subject: "shared-topic",
		});
		expect(filtered).toHaveLength(1);
		expect(filtered[0]?.verdict).toBe("escalate");
	});

	it("matches subject independently of consumerKey", () => {
		expect(filterAuditEvents(SEED, { subject: "shared-topic" })).toHaveLength(1);
		expect(filterAuditEvents(SEED, { consumerKey: "shared-topic" })).toHaveLength(0);
	});

	it("combines every dimension at once", () => {
		const filtered = filterAuditEvents(SEED, {
			consumerKey: "alice-key",
			control: "semantic",
			since: "2026-01-04T00:00:00.000Z",
			subject: "shared-topic",
			until: "2026-01-04T00:00:00.000Z",
			verdict: "escalate",
		});
		expect(filtered).toHaveLength(1);
		expect(filtered[0]?.controlId).toBe("semantic");
	});

	it("emits the canonical CSV header with consumerKey", () => {
		expect(auditEventsToCsv(SEED).split("\n")[0]).toBe(EXPECTED_HEADER);
	});

	it("emits one CSV row per event carrying its key", () => {
		const rows = auditEventsToCsv(SEED).split("\n");
		expect(rows).toHaveLength(SEED.length + 1);
		expect(rows[1]).toContain("alice-key");
		expect(rows[2]).toContain("bob-key");
	});

	it("quotes CSV cells containing commas", () => {
		const event = makeEvent({
			consumerKey: "alice-key",
			detail: "hello, world",
			subject: "alice-key",
			timestamp: "2026-01-05T00:00:00.000Z",
			verdict: "allow",
		});
		expect(auditEventsToCsv([event]).split("\n")[1]).toContain('"hello, world"');
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
