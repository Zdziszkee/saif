/**
 * Concurrency isolation: one hosted instance serves many consumer subjects at
 * once. These tests fire interleaved requests through the guard API seam and
 * assert that verdicts and audit attribution never cross subjects, which is
 * the multi-tenancy guarantee documented in `docs/architecture.md`.
 */
import { describe, expect, test } from "bun:test";

import { createInMemoryAuditSink } from "#/control/audit.ts";
import { handleGuardRequest } from "#/control/guard-api.ts";
import { createConsumerResolver } from "#/control/subjects.ts";
import type { ControlPipeline, InspectionResult, Interaction } from "#/control/types.ts";

/** Pipeline double: `bob` is blocked, `alice` is allowed; every call yields. */
function interleavingPipeline(): ControlPipeline {
	return {
		async inspect(interaction: Interaction): Promise<InspectionResult> {
			await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 5)));
			const blocked = interaction.subject === "bob";
			return {
				blockingControl: blocked ? "test-double" : undefined,
				content: interaction.content,
				flagged: false,
				hits: [],
				redactions: [],
				verdict: blocked ? "block" : "allow",
			};
		},
	};
}

function guardRequest(subject: string, content: string): Request {
	return new Request("http://localhost/api/guard", {
		body: JSON.stringify({ content, direction: "inbound", seam: "guard-api" }),
		headers: { "content-type": "application/json", "x-consumer-key": subject },
		method: "POST",
	});
}

describe("concurrency isolation across consumer subjects", () => {
	test("interleaved requests keep verdicts and audit attributed to their own subject", async () => {
		const audit = createInMemoryAuditSink();
		const consumers = createConsumerResolver({
			defaultSubject: "default",
			knownKeys: ["alice", "bob"],
			unknownKey: "reject",
		});
		const deps = { audit, consumers, pipeline: interleavingPipeline() };

		const calls = Array.from({ length: 40 }, (_, i) => {
			const subject = i % 2 === 0 ? "alice" : "bob";
			return {
				promise: handleGuardRequest(guardRequest(subject, `payload-${i}`), deps),
				subject,
			};
		});

		const results = await Promise.all(calls.map((call) => call.promise));
		const outcomes = await Promise.all(
			results.map(async (response) => ({
				body: (await response.json()) as { verdict?: string },
				status: response.status,
			})),
		);

		for (const [index, outcome] of outcomes.entries()) {
			const call = calls[index];
			if (call === undefined) {
				throw new Error(`missing call ${index}`);
			}
			expect(outcome.body.verdict).toBe(call.subject === "bob" ? "block" : "allow");
			expect(outcome.status).toBe(call.subject === "bob" ? 403 : 200);
		}

		expect(audit.events.length).toBe(calls.length);
		for (const event of audit.events) {
			expect(event.subject === "alice" || event.subject === "bob").toBe(true);
		}
	});

	test("an unknown consumer key is rejected and never inherits another subject's verdict", async () => {
		const audit = createInMemoryAuditSink();
		const consumers = createConsumerResolver({
			defaultSubject: "default",
			knownKeys: ["alice", "bob"],
			unknownKey: "reject",
		});
		const deps = { audit, consumers, pipeline: interleavingPipeline() };

		const results = await Promise.all([
			handleGuardRequest(guardRequest("mallory", "payload"), deps),
			handleGuardRequest(guardRequest("alice", "payload"), deps),
		]);
		const [unknown, known] = results;
		if (unknown === undefined || known === undefined) {
			throw new Error("missing response");
		}

		expect(unknown.status).toBe(403);
		expect(known.status).toBe(200);

		// The rejection is audited without a subject; only alice's request is
		// governed and attributed.
		const rejection = audit.events.find((event) => event.controlId === "consumer-key");
		expect(rejection?.verdict).toBe("block");
		expect(rejection?.subject).toBeUndefined();
		const governed = audit.events.filter((event) => event.subject === "alice");
		expect(governed.length).toBe(1);
	});
});
