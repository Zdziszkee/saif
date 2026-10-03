import { describe, expect, it } from "bun:test";

import {
	auditEvent,
	auditEventsToCsv,
	auditEventsToJsonl,
	filterAuditEvents,
	isAuditDecision,
	readAuditEvents,
	summarizeAuditDecisions,
} from "#/control/audit.ts";
import { handleGuardRequest } from "#/control/guard-api.ts";
import { createToolCatalog } from "#/hub/catalog.ts";

import {
	auditSink,
	blockOn,
	consumerResolver,
	failingControl,
	pipelineWith,
} from "./helpers/fixtures.ts";

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

describe("audit decisions", () => {
	it("treats only interaction events with a verdict as decisions", () => {
		expect(isAuditDecision(auditEvent("interaction", { verdict: "block" }))).toBe(true);
		expect(isAuditDecision(auditEvent("interaction", {}))).toBe(false);
		expect(isAuditDecision(auditEvent("registration", { verdict: "escalate" }))).toBe(false);
		expect(isAuditDecision(auditEvent("failure", { verdict: "escalate" }))).toBe(false);
	});

	it("counts one guard call as one decision despite registration and info noise", async () => {
		const audit = auditSink();
		const pipeline = pipelineWith([blockOn("EVIL"), failingControl("boom")], {
			audit,
			failureVerdict: "escalate",
		});
		const catalog = createToolCatalog({ audit, pipeline });
		const admitted = await catalog.register({
			description: "A harmless demo tool",
			grantedByDefault: true,
			implementation: () => "ok",
			inputSchema: {},
			name: "demoTool",
			source: "builtin",
		});
		// No EVIL marker in the schema, so the failing control trips fail-closed.
		expect(admitted.ok).toBe(false);

		const request = new Request("http://test.local/api/guard", {
			body: JSON.stringify({ content: "EVIL payload", direction: "inbound", seam: "guard-api" }),
			headers: new Headers({ "content-type": "application/json" }),
			method: "POST",
		});
		const response = await handleGuardRequest(request, {
			audit,
			consumers: consumerResolver(),
			pipeline,
		});
		expect(response.status).toBe(403);

		// The sink holds the registration admission plus the verdict-less
		// consumer-key note alongside the real outcome...
		expect(audit.events.length).toBeGreaterThan(1);
		// ...but the dashboard summary counts exactly one decision.
		const summary = summarizeAuditDecisions(readAuditEvents(audit));
		expect(summary.total).toBe(1);
		expect(summary.byVerdict).toEqual([["block", 1]]);
		expect(summary.byControl).toEqual([["fixture-block", 1]]);
		expect(summary.recent).toHaveLength(1);
	});
});
