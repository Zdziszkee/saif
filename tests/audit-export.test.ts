import { describe, expect, it } from "bun:test";

import {
	auditEvent,
	auditEventsToCsv,
	auditEventsToJsonl,
	filterAuditEvents,
} from "#/control/audit.ts";

const seed = [
	auditEvent("interaction", {
		controlId: "deterministic",
		subject: "alice",
		verdict: "redact",
	}),
	auditEvent("interaction", {
		controlId: "signatures",
		subject: "alice",
		verdict: "block",
	}),
	auditEvent("interaction", {
		controlId: "deterministic",
		detail: 'quoted "value", and more',
		subject: "deploy-bot",
		verdict: "allow",
	}),
];

describe("audit export", () => {
	it("filters by verdict, control, and subject", () => {
		expect(filterAuditEvents(seed, { verdict: "block" })).toHaveLength(1);
		expect(filterAuditEvents(seed, { control: "deterministic" })).toHaveLength(2);
		expect(filterAuditEvents(seed, { subject: "deploy-bot" })).toHaveLength(1);
		expect(filterAuditEvents(seed, {})).toHaveLength(3);
	});

	it("emits parseable JSONL", () => {
		const lines = auditEventsToJsonl(seed).split("\n");
		expect(lines).toHaveLength(3);
		for (const line of lines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
	});

	it("emits a header row and RFC 4180 quoting", () => {
		const rows = auditEventsToCsv(seed).split("\n");
		expect(rows[0]).toBe(
			"timestamp,kind,verdict,controlId,subject,seam,interactionId,detail,redactionCount",
		);
		expect(rows).toHaveLength(4);
		expect(rows[3]).toContain('"quoted ""value"", and more"');
	});
});
