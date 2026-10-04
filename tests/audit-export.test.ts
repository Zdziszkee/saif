import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	auditEvent,
	auditEventsToCsv,
	auditEventsToJsonl,
	combineAuditSinks,
	filterAuditEvents,
	isAuditDecision,
	readAuditEvents,
	summarizeAuditDecisions,
} from "#/control/audit.ts";
import { createFileAuditSink } from "#/control/audit-file.ts";
import { handleGuardRequest } from "#/control/guard-api.ts";
import { USER_GROUP_ID_HEADER, USER_ID_HEADER } from "#/control/subjects.ts";
import { createToolCatalog } from "#/hub/catalog.ts";

import {
	auditSink,
	blockOn,
	failingControl,
	identityResolver,
	pipelineWith,
} from "./helpers/fixtures.ts";

const seed = [
	auditEvent("interaction", {
		controlId: "deterministic",
		groupId: "alice",
		verdict: "redact",
	}),
	auditEvent("interaction", {
		controlId: "signatures",
		groupId: "alice",
		verdict: "block",
	}),
	auditEvent("interaction", {
		controlId: "deterministic",
		detail: 'quoted "value", and more',
		groupId: "deploy-bot",
		verdict: "allow",
	}),
];

describe("audit export", () => {
	it("filters by verdict, control, and groupId", () => {
		expect(filterAuditEvents(seed, { verdict: "block" })).toHaveLength(1);
		expect(filterAuditEvents(seed, { control: "deterministic" })).toHaveLength(2);
		expect(filterAuditEvents(seed, { groupId: "deploy-bot" })).toHaveLength(1);
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
			"timestamp,kind,verdict,controlId,groupId,consumerKey,seam,interactionId,detail,redactionCount",
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

		const headers = new Headers({ "content-type": "application/json" });
		headers.set(USER_ID_HEADER, "alice");
		headers.set(USER_GROUP_ID_HEADER, "hr");
		const request = new Request("http://test.local/api/guard", {
			body: JSON.stringify({ content: "EVIL payload", direction: "inbound", seam: "guard-api" }),
			headers,
			method: "POST",
		});
		const response = await handleGuardRequest(request, {
			audit,
			identity: identityResolver(),
			pipeline,
		});
		expect(response.status).toBe(403);

		// The sink holds the registration admission plus the fail-closed
		// failure notes alongside the real outcome...
		expect(audit.events.length).toBeGreaterThan(1);
		// ...but the dashboard summary counts exactly one decision.
		const summary = summarizeAuditDecisions(readAuditEvents(audit));
		expect(summary.total).toBe(1);
		expect(summary.byVerdict).toEqual([["block", 1]]);
		expect(summary.byControl).toEqual([["fixture-block", 1]]);
		expect(summary.recent).toHaveLength(1);
	});
});

describe("file audit sink", () => {
	it("appends one parseable JSONL line per event", async () => {
		const dir = await mkdtemp(join(tmpdir(), "saif-audit-"));
		const path = join(dir, "audit.jsonl");
		try {
			const sink = createFileAuditSink(path);
			sink.record(auditEvent("interaction", { groupId: "alice", verdict: "allow" }));
			sink.record(auditEvent("interaction", { groupId: "bob", verdict: "block" }));
			const lines = (await readFile(path, "utf8")).trim().split("\n");
			expect(lines).toHaveLength(2);
			expect((JSON.parse(lines[0] ?? "") as { groupId?: string }).groupId).toBe("alice");
			expect((JSON.parse(lines[1] ?? "") as { verdict?: string }).verdict).toBe("block");
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("fans out to every combined sink", async () => {
		const dir = await mkdtemp(join(tmpdir(), "saif-audit-"));
		const path = join(dir, "audit.jsonl");
		try {
			const memory = auditSink();
			const combined = combineAuditSinks(memory, createFileAuditSink(path));
			combined.record(auditEvent("interaction", { groupId: "alice", verdict: "allow" }));
			expect(memory.events).toHaveLength(1);
			const lines = (await readFile(path, "utf8")).trim().split("\n");
			expect(lines).toHaveLength(1);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});
});
