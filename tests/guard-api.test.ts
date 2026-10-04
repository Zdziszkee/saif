import { describe, expect, it } from "bun:test";
import { handleGuardRequest } from "#/control/guard-api.ts";
import { type CallerIdentity, USER_GROUP_ID_HEADER, USER_ID_HEADER } from "#/control/subjects.ts";
import type { ControlPipeline, Interaction } from "#/control/types.ts";
import {
	auditSink,
	blockOn,
	blockSubject,
	escalateOn,
	failingControl,
	identityResolver,
	pipelineWith,
	redactOn,
} from "./helpers/fixtures.ts";

const alice: CallerIdentity = { groupId: "hr", userId: "alice" };
const bob: CallerIdentity = { groupId: "manager", userId: "bob" };
const ghost: CallerIdentity = { groupId: "ghost-group", userId: "ghost" };

function guardRequest(body: unknown, identity?: Partial<CallerIdentity>): Request {
	const headers = new Headers({ "content-type": "application/json" });
	if (identity?.userId !== undefined) {
		headers.set(USER_ID_HEADER, identity.userId);
	}
	if (identity?.groupId !== undefined) {
		headers.set(USER_GROUP_ID_HEADER, identity.groupId);
	}
	return new Request("http://test.local/api/guard", {
		body: JSON.stringify(body),
		headers,
		method: "POST",
	});
}

const envelope = { content: "hello world", direction: "inbound", seam: "guard-api" };

interface GuardBody {
	content?: string;
	control?: string;
	details?: string[];
	error?: string;
	flagged?: boolean;
	reason?: string;
	verdict?: string;
}

async function jsonOf(response: Response): Promise<GuardBody> {
	return (await response.json()) as GuardBody;
}

describe("guard API", () => {
	it("forwards allowed interactions (positive case)", async () => {
		const response = await handleGuardRequest(guardRequest(envelope, alice), {
			identity: identityResolver(),
			pipeline: pipelineWith([]),
		});
		expect(response.status).toBe(200);
		const body = await jsonOf(response);
		expect(body.verdict).toBe("allow");
		expect(body.content).toBe("hello world");
	});

	it("redacts flagged spans and preserves surrounding content (negative case)", async () => {
		const response = await handleGuardRequest(
			guardRequest({ ...envelope, content: "token SECRET-1 stays" }, alice),
			{
				identity: identityResolver(),
				pipeline: pipelineWith([redactOn("SECRET-1", "[TOKEN]")]),
			},
		);
		expect(response.status).toBe(200);
		const body = await jsonOf(response);
		expect(body.verdict).toBe("redact");
		expect(body.content).toBe("token [TOKEN] stays");
	});

	it("blocks with the defined rejection shape and forwards no content", async () => {
		const response = await handleGuardRequest(
			guardRequest({ ...envelope, content: "EVIL payload" }, alice),
			{
				identity: identityResolver(),
				pipeline: pipelineWith([blockOn("EVIL")]),
			},
		);
		expect(response.status).toBe(403);
		const body = await jsonOf(response);
		expect(body.verdict).toBe("block");
		expect(body.error).toBe("blocked");
		expect(body.control).toBe("fixture-block");
		expect(body.content).toBeUndefined();
	});

	it("escalates without forwarding the content", async () => {
		const response = await handleGuardRequest(
			guardRequest({ ...envelope, content: "HOLD for review" }, alice),
			{
				identity: identityResolver(),
				pipeline: pipelineWith([escalateOn("HOLD")]),
			},
		);
		expect(response.status).toBe(403);
		const body = await jsonOf(response);
		expect(body.verdict).toBe("escalate");
		expect(body.error).toBe("escalated");
		expect(body.content).toBeUndefined();
	});

	it("rejects malformed requests before any control evaluation", async () => {
		const seen: Interaction[] = [];
		const spyPipeline: ControlPipeline = {
			inspect: (interaction) => {
				seen.push(interaction);
				return Promise.resolve({
					content: interaction.content,
					flagged: false,
					hits: [],
					redactions: [],
					verdict: "allow",
				});
			},
		};
		const response = await handleGuardRequest(guardRequest({ direction: "inbound" }, alice), {
			identity: identityResolver(),
			pipeline: spyPipeline,
		});
		expect(response.status).toBe(400);
		const body = await jsonOf(response);
		expect(body.error).toBe("malformed_request");
		expect(seen).toHaveLength(0);
	});

	it("fails closed when a control errors", async () => {
		const audit = auditSink();
		const response = await handleGuardRequest(guardRequest(envelope, alice), {
			audit,
			identity: identityResolver(),
			pipeline: pipelineWith([failingControl("boom")], { audit }),
		});
		expect(response.status).toBe(403);
		const body = await jsonOf(response);
		expect(body.verdict).toBe("block");
		expect(body.control).toBe("fixture-failure");
		expect(audit.events.some((event) => event.kind === "failure")).toBe(true);
	});

	it("governs concurrent consumers in isolation", async () => {
		const audit = auditSink();
		const deps = {
			audit,
			identity: identityResolver(),
			pipeline: pipelineWith([blockSubject("manager", "MARKER")]),
		};
		const [aliceResponse, bobResponse] = await Promise.all([
			handleGuardRequest(guardRequest({ ...envelope, content: "MARKER for me" }, alice), deps),
			handleGuardRequest(guardRequest({ ...envelope, content: "MARKER for me" }, bob), deps),
		]);
		expect((await jsonOf(aliceResponse)).verdict).toBe("allow");
		expect((await jsonOf(bobResponse)).verdict).toBe("block");

		const groups = audit.events
			.filter((event) => event.kind === "interaction" && event.verdict !== undefined)
			.map((event) => event.groupId)
			.sort();
		expect(groups).toEqual(["hr", "manager"]);
	});

	it("rejects an unknown user group and records the reason", async () => {
		const audit = auditSink();
		const response = await handleGuardRequest(guardRequest(envelope, ghost), {
			audit,
			identity: identityResolver(),
			pipeline: pipelineWith([]),
		});
		expect(response.status).toBe(403);
		const body = await jsonOf(response);
		expect(body.control).toBe("caller-identity");
		expect(body.error).toBe("rejected");
		expect(body.reason).toContain("ghost-group");
		expect(
			audit.events.some(
				(event) =>
					event.controlId === "caller-identity" &&
					event.detail?.includes("user group not defined by policy"),
			),
		).toBe(true);
	});

	it("rejects requests with no identity headers at all", async () => {
		const audit = auditSink();
		const response = await handleGuardRequest(guardRequest(envelope), {
			audit,
			identity: identityResolver(),
			pipeline: pipelineWith([]),
		});
		expect(response.status).toBe(403);
		const body = await jsonOf(response);
		expect(body.control).toBe("caller-identity");
		expect(audit.events.some((event) => event.detail?.includes("no x-user-id presented"))).toBe(
			true,
		);
	});

	it("rejects when the user id is present but the group is missing", async () => {
		const audit = auditSink();
		const response = await handleGuardRequest(guardRequest(envelope, { userId: "alice" }), {
			audit,
			identity: identityResolver(),
			pipeline: pipelineWith([]),
		});
		expect(response.status).toBe(403);
		const body = await jsonOf(response);
		expect(body.reason).toContain("x-user-group-id");
	});

	it("records the calling user and group on allowed traffic", async () => {
		const audit = auditSink();
		await handleGuardRequest(guardRequest(envelope, alice), {
			audit,
			identity: identityResolver(),
			pipeline: pipelineWith([]),
		});
		const event = audit.events.find((entry) => entry.kind === "interaction");
		expect(event?.userId).toBe("alice");
		expect(event?.groupId).toBe("hr");
	});
});
