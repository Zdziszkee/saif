import { describe, expect, it } from "bun:test";
import { handleGuardRequest } from "#/control/guard-api.ts";
import { CONSUMER_KEY_HEADER } from "#/control/subjects.ts";
import type { ControlPipeline, Interaction } from "#/control/types.ts";
import {
	auditSink,
	blockOn,
	blockSubject,
	consumerResolver,
	escalateOn,
	failingControl,
	pipelineWith,
	redactOn,
} from "./helpers/fixtures.ts";

function guardRequest(body: unknown, consumerKey?: string): Request {
	const headers = new Headers({ "content-type": "application/json" });
	if (consumerKey !== undefined) {
		headers.set(CONSUMER_KEY_HEADER, consumerKey);
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
		const response = await handleGuardRequest(guardRequest(envelope, "alice"), {
			consumers: consumerResolver(),
			pipeline: pipelineWith([]),
		});
		expect(response.status).toBe(200);
		const body = await jsonOf(response);
		expect(body.verdict).toBe("allow");
		expect(body.content).toBe("hello world");
	});

	it("redacts flagged spans and preserves surrounding content (negative case)", async () => {
		const response = await handleGuardRequest(
			guardRequest({ ...envelope, content: "token SECRET-1 stays" }, "alice"),
			{
				consumers: consumerResolver(),
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
			guardRequest({ ...envelope, content: "EVIL payload" }, "alice"),
			{
				consumers: consumerResolver(),
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
			guardRequest({ ...envelope, content: "HOLD for review" }, "alice"),
			{
				consumers: consumerResolver(),
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
		const response = await handleGuardRequest(guardRequest({ direction: "inbound" }, "alice"), {
			consumers: consumerResolver(),
			pipeline: spyPipeline,
		});
		expect(response.status).toBe(400);
		const body = await jsonOf(response);
		expect(body.error).toBe("malformed_request");
		expect(seen).toHaveLength(0);
	});

	it("fails closed when a control errors", async () => {
		const audit = auditSink();
		const response = await handleGuardRequest(guardRequest(envelope, "alice"), {
			audit,
			consumers: consumerResolver(),
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
			consumers: consumerResolver(),
			pipeline: pipelineWith([blockSubject("bob", "MARKER")]),
		};
		const [aliceResponse, bobResponse] = await Promise.all([
			handleGuardRequest(guardRequest({ ...envelope, content: "MARKER for me" }, "alice"), deps),
			handleGuardRequest(guardRequest({ ...envelope, content: "MARKER for me" }, "bob"), deps),
		]);
		expect((await jsonOf(aliceResponse)).verdict).toBe("allow");
		expect((await jsonOf(bobResponse)).verdict).toBe("block");

		const subjects = audit.events
			.filter((event) => event.kind === "interaction" && event.verdict !== undefined)
			.map((event) => event.subject)
			.sort();
		expect(subjects).toEqual(["alice", "bob"]);
	});

	it("routes unknown consumer keys to the configured default subject and records it", async () => {
		const audit = auditSink();
		const response = await handleGuardRequest(guardRequest(envelope, "ghost"), {
			audit,
			consumers: consumerResolver(),
			pipeline: pipelineWith([]),
		});
		expect(response.status).toBe(200);
		expect(
			audit.events.some((event) => event.detail?.includes("resolved to default subject")),
		).toBe(true);
		expect(
			audit.events.some((event) => event.detail?.includes("ghost") && event.subject === "default"),
		).toBe(true);
	});

	it("rejects unknown consumer keys when the policy configures rejection", async () => {
		const audit = auditSink();
		const response = await handleGuardRequest(guardRequest(envelope, "ghost"), {
			audit,
			consumers: consumerResolver({ unknownKey: "reject" }),
			pipeline: pipelineWith([]),
		});
		expect(response.status).toBe(403);
		const body = await jsonOf(response);
		expect(body.control).toBe("consumer-key");
		expect(body.error).toBe("rejected");
		expect(audit.events.some((event) => event.detail?.includes("consumer key rejected"))).toBe(
			true,
		);
	});

	it("applies default-subject behavior to requests with no consumer key", async () => {
		const audit = auditSink();
		const response = await handleGuardRequest(guardRequest(envelope), {
			audit,
			consumers: consumerResolver(),
			pipeline: pipelineWith([]),
		});
		expect(response.status).toBe(200);
		expect(
			audit.events.some((event) => event.detail?.includes("resolved to default subject")),
		).toBe(true);
	});
});
