/**
 * Concurrency isolation: one hosted instance serves many users and user
 * groups at once. These tests fire interleaved requests through the guard API
 * seam and assert that verdicts and audit attribution never cross subjects,
 * which is the multi-tenancy guarantee documented in `docs/architecture.md`.
 */
import { describe, expect, test } from "bun:test";

import { createInMemoryAuditSink } from "#/control/audit.ts";
import { handleGuardRequest } from "#/control/guard-api.ts";
import { USER_GROUP_ID_HEADER, USER_ID_HEADER } from "#/control/subjects.ts";
import type { ControlPipeline, InspectionResult, Interaction } from "#/control/types.ts";
import { identityResolver } from "./helpers/fixtures.ts";

/** Pipeline double: `bob`'s group is blocked, `alice`'s group is allowed; every call yields. */
function interleavingPipeline(): ControlPipeline {
	return {
		async inspect(interaction: Interaction): Promise<InspectionResult> {
			await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 5)));
			const blocked = interaction.groupId === "manager";
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

function guardRequest(userId: string, groupId: string, content: string): Request {
	return new Request("http://localhost/api/guard", {
		body: JSON.stringify({ content, direction: "inbound", seam: "guard-api" }),
		headers: {
			"content-type": "application/json",
			[USER_GROUP_ID_HEADER]: groupId,
			[USER_ID_HEADER]: userId,
		},
		method: "POST",
	});
}

describe("concurrency isolation across user groups", () => {
	test("interleaved requests keep verdicts and audit attributed to their own groupId", async () => {
		const audit = createInMemoryAuditSink();
		const deps = { audit, identity: identityResolver(), pipeline: interleavingPipeline() };

		const calls = Array.from({ length: 40 }, (_, i) => {
			const identity =
				i % 2 === 0 ? { groupId: "hr", userId: "alice" } : { groupId: "manager", userId: "bob" };
			return {
				identity,
				promise: handleGuardRequest(
					guardRequest(identity.userId, identity.groupId, `payload-${i}`),
					deps,
				),
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
			const blocked = call.identity.groupId === "manager";
			expect(outcome.body.verdict).toBe(blocked ? "block" : "allow");
			expect(outcome.status).toBe(blocked ? 403 : 200);
		}

		expect(audit.events.length).toBe(calls.length);
		for (const event of audit.events) {
			expect(event.groupId === "hr" || event.groupId === "manager").toBe(true);
		}
	});

	test("an unknown user group is rejected and never inherits another groupId's verdict", async () => {
		const audit = createInMemoryAuditSink();
		const deps = { audit, identity: identityResolver(), pipeline: interleavingPipeline() };

		const results = await Promise.all([
			handleGuardRequest(guardRequest("mallory", "ghost-group", "payload"), deps),
			handleGuardRequest(guardRequest("alice", "hr", "payload"), deps),
		]);
		const [unknown, known] = results;
		if (unknown === undefined || known === undefined) {
			throw new Error("missing response");
		}

		expect(unknown.status).toBe(403);
		expect(known.status).toBe(200);

		// The rejection is audited with the presented (untrusted) identity so
		// the attempt is traceable; only alice's request is governed and
		// attributed as a known user in a known group.
		const rejection = audit.events.find((event) => event.controlId === "caller-identity");
		expect(rejection?.verdict).toBe("block");
		expect(rejection?.groupId).toBe("ghost-group");
		expect(rejection?.userId).toBe("mallory");
		const governed = audit.events.filter((event) => event.userId === "alice");
		expect(governed.length).toBe(1);
		expect(governed[0]?.groupId).toBe("hr");
	});
});
