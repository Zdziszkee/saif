import { describe, expect, it } from "bun:test";

import { createInMemoryAuditSink, readAuditEvents } from "#/control/audit.ts";
import { guardInteraction } from "#/control/guard.ts";
import { handleGuardRequest } from "#/control/guard-api.ts";
import { type CallerIdentity, createIdentityResolver } from "#/control/subjects.ts";
import type { ControlPipeline, Interaction } from "#/control/types.ts";

/**
 * Guard identity attribution: every `handleGuardRequest` outcome is recorded
 * against the calling user (`consumerKey` carries the `userId` value,
 * `"(none)"` only when no user was presented) with the policy subject
 * (`groupId`) and the individual (`userId`) alongside it. A known user in a
 * known group governs normally; a missing identity or an unknown group is
 * rejected with no fallback to another caller's configuration.
 * `guardInteraction` defaults an absent `consumerKey` option to `"(none)"`.
 */

const resolver = createIdentityResolver({ knownGroups: ["hr", "manager"] });

const alice: CallerIdentity = { groupId: "hr", userId: "alice" };
const bob: CallerIdentity = { groupId: "manager", userId: "bob" };
const ghost: CallerIdentity = { groupId: "ghost-group", userId: "ghost" };

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

function guardRequest(body: unknown, identity?: Partial<CallerIdentity>): Request {
	const headers = new Headers({ "content-type": "application/json" });
	if (identity?.userId !== undefined) {
		headers.set("x-user-id", identity.userId);
	}
	if (identity?.groupId !== undefined) {
		headers.set("x-user-group-id", identity.groupId);
	}
	return new Request("http://test.local/api/guard", {
		body: JSON.stringify(body),
		headers,
		method: "POST",
	});
}

interface GuardBody {
	content?: string;
	control?: string;
	error?: string;
	reason?: string;
	verdict?: string;
}

async function jsonOf(response: Response): Promise<GuardBody> {
	return (await response.json()) as GuardBody;
}

describe("guard identity recording", () => {
	it("known identity records consumerKey, groupId, and userId", async () => {
		const sink = createInMemoryAuditSink();
		const seen: Interaction[] = [];
		const spy: ControlPipeline = {
			inspect: (interaction) => {
				seen.push(interaction);
				return allowPipeline.inspect(interaction);
			},
		};

		const response = await handleGuardRequest(guardRequest(envelope, alice), {
			audit: sink,
			identity: resolver,
			pipeline: spy,
		});

		expect(response.status).toBe(200);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.groupId).toBe("hr");
		expect(seen[0]?.userId).toBe("alice");
		const decisions = readAuditEvents(sink).filter(
			(event) => event.kind === "interaction" && event.verdict !== undefined,
		);
		expect(decisions).toHaveLength(1);
		expect(decisions[0]?.consumerKey).toBe("alice");
		expect(decisions[0]?.groupId).toBe("hr");
		expect(decisions[0]?.userId).toBe("alice");
	});

	it("unknown group is rejected without falling back to a known group", async () => {
		const sink = createInMemoryAuditSink();
		const seen: Interaction[] = [];
		const spy: ControlPipeline = {
			inspect: (interaction) => {
				seen.push(interaction);
				return allowPipeline.inspect(interaction);
			},
		};

		const response = await handleGuardRequest(guardRequest(envelope, ghost), {
			audit: sink,
			identity: resolver,
			pipeline: spy,
		});

		expect(response.status).toBe(403);
		expect(seen).toHaveLength(0);
		const body = await jsonOf(response);
		expect(body.control).toBe("caller-identity");
		expect(body.error).toBe("rejected");
		expect(body.reason).toContain("ghost-group");
		const events = readAuditEvents(sink);
		expect(events).toHaveLength(1);
		expect(events[0]?.controlId).toBe("caller-identity");
		expect(events[0]?.groupId).toBe("ghost-group");
		expect(events[0]?.userId).toBe("ghost");
		expect(events[0]?.verdict).toBe("block");
	});

	it("missing identity is rejected without invoking the pipeline", async () => {
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
			identity: resolver,
			pipeline: spy,
		});

		expect(response.status).toBe(403);
		expect(seen).toHaveLength(0);
		const body = await jsonOf(response);
		expect(body.control).toBe("caller-identity");
		expect(body.reason).toContain("x-user-id");
		const events = readAuditEvents(sink);
		expect(events).toHaveLength(1);
		expect(events[0]?.groupId).toBeUndefined();
		expect(events[0]?.userId).toBeUndefined();
		expect(events[0]?.verdict).toBe("block");
	});

	it("user id without a group is rejected without invoking the pipeline", async () => {
		const sink = createInMemoryAuditSink();
		const seen: Interaction[] = [];
		const spy: ControlPipeline = {
			inspect: (interaction) => {
				seen.push(interaction);
				return allowPipeline.inspect(interaction);
			},
		};

		const response = await handleGuardRequest(guardRequest(envelope, { userId: "alice" }), {
			audit: sink,
			identity: resolver,
			pipeline: spy,
		});

		expect(response.status).toBe(403);
		expect(seen).toHaveLength(0);
		const body = await jsonOf(response);
		expect(body.reason).toContain("x-user-group-id");
	});

	it("malformed request records consumerKey, groupId, and userId without invoking the pipeline", async () => {
		const sink = createInMemoryAuditSink();
		const seen: Interaction[] = [];
		const spy: ControlPipeline = {
			inspect: (interaction) => {
				seen.push(interaction);
				return allowPipeline.inspect(interaction);
			},
		};

		const response = await handleGuardRequest(guardRequest({ direction: "inbound" }, bob), {
			audit: sink,
			identity: resolver,
			pipeline: spy,
		});

		expect(response.status).toBe(400);
		expect(seen).toHaveLength(0);
		const events = readAuditEvents(sink);
		expect(events).toHaveLength(1);
		expect(events[0]?.consumerKey).toBe("bob");
		expect(events[0]?.groupId).toBe("manager");
		expect(events[0]?.userId).toBe("bob");
		expect(events[0]?.verdict).toBeUndefined();
	});

	describe("identity resolve matrix at the guard seam", () => {
		const matrix: {
			identity: Partial<CallerIdentity> | undefined;
			label: string;
			status: 200 | 403;
		}[] = [
			{ identity: alice, label: "known user in a known group", status: 200 },
			{ identity: bob, label: "second known user in a known group", status: 200 },
			{ identity: ghost, label: "unknown group", status: 403 },
			{ identity: { groupId: "hr" }, label: "missing user id", status: 403 },
			{ identity: { userId: "alice" }, label: "missing group id", status: 403 },
			{ identity: undefined, label: "missing identity", status: 403 },
		];

		for (const { identity, label, status } of matrix) {
			it(`${label} answers ${status}`, async () => {
				const sink = createInMemoryAuditSink();
				const seen: Interaction[] = [];
				const spy: ControlPipeline = {
					inspect: (interaction) => {
						seen.push(interaction);
						return allowPipeline.inspect(interaction);
					},
				};
				const response = await handleGuardRequest(guardRequest(envelope, identity), {
					audit: sink,
					identity: resolver,
					pipeline: spy,
				});
				expect(response.status).toBe(status);
				expect(seen).toHaveLength(status === 200 ? 1 : 0);
			});
		}
	});
});

describe("guardInteraction consumerKey", () => {
	it("defaults an absent consumerKey to (none)", async () => {
		const sink = createInMemoryAuditSink();

		await guardInteraction(
			{
				content: "hello",
				direction: "inbound",
				groupId: "hr",
				id: "int_1",
				seam: "guard-api",
			},
			allowPipeline,
			{ audit: sink },
		);

		const events = readAuditEvents(sink);
		expect(events).toHaveLength(1);
		expect(events[0]?.consumerKey).toBe("(none)");
		expect(events[0]?.groupId).toBe("hr");
	});

	it("records an explicit consumerKey alongside groupId and userId", async () => {
		const sink = createInMemoryAuditSink();

		await guardInteraction(
			{
				content: "hello",
				direction: "inbound",
				groupId: "hr",
				id: "int_1",
				seam: "guard-api",
				userId: "alice",
			},
			allowPipeline,
			{ audit: sink, consumerKey: "alice" },
		);

		const events = readAuditEvents(sink);
		expect(events).toHaveLength(1);
		expect(events[0]?.consumerKey).toBe("alice");
		expect(events[0]?.groupId).toBe("hr");
		expect(events[0]?.userId).toBe("alice");
	});
});
