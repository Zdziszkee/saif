import { describe, expect, it } from "bun:test";
import { createHubConfig } from "#/hub/config.ts";
import { createHub } from "#/hub/mcp-server.ts";
import { createExternalServer } from "./helpers/external-server.ts";
import { auditSink, modelDouble, pipelineWith, staticReply } from "./helpers/fixtures.ts";

const TOKEN = "SECRET-SERVICE-TOKEN-123";

function headerValue(headers: Record<string, string>, name: string): string | undefined {
	return headers[name];
}

function connectionHub(allowlist: string[]) {
	const external = createExternalServer();
	const audit = auditSink();
	const model = modelDouble(() => staticReply("model answer"));
	return {
		audit,
		external,
		hubPromise: createHub({
			audit,
			config: createHubConfig({ egressAllowlist: allowlist }),
			fetch: external.fetch,
			model,
			pipeline: pipelineWith([]),
		}),
		model,
	};
}

describe("hub connections", () => {
	it("rejects endpoints outside the egress allowlist and records the attempt", async () => {
		const { audit, hubPromise } = connectionHub(["https://allowed.test"]);
		const hub = await hubPromise;
		const outcome = await hub.addConnection({
			endpoint: "https://ext.test/mcp",
			groupId: "alice",
			name: "ext",
			token: TOKEN,
		});
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.error).toContain("egress allowlist");
		}
		expect(hub.connections.list()).toHaveLength(0);
		expect(
			audit.events.some((event) => event.kind === "connection" && event.verdict === "block"),
		).toBe(true);
	});

	it("registers connected tools ungranted and denies calls until granted", async () => {
		const { audit, hubPromise } = connectionHub(["https://ext.test"]);
		const hub = await hubPromise;
		const connected = await hub.addConnection({
			endpoint: "https://ext.test/mcp",
			groupId: "alice",
			name: "ext",
		});
		expect(connected.ok).toBe(true);
		expect(hub.toolNames()).toContain("ext_echo");

		const denied = await hub.invokeTool("ext_echo", { text: "hi" }, "alice");
		expect(denied.kind).toBe("refused");
		if (denied.kind === "refused") {
			expect(denied.rejection.kind).toBe("denied");
			expect(denied.rejection.control).toBe("tool-authorization");
		}
		expect(audit.events.some((event) => event.detail?.includes("ungranted") === true)).toBe(true);

		hub.grant("alice", "ext_echo");
		const allowed = await hub.invokeTool("ext_echo", { text: "hi" }, "alice");
		expect(allowed.kind).toBe("executed");
		if (allowed.kind === "executed") {
			expect(allowed.result).toEqual({ echoed: "hi" });
		}

		const stillDenied = await hub.invokeTool("ext_echo", { text: "hi" }, "bob");
		expect(stillDenied.kind).toBe("refused");
	});

	it("connects several servers through the client pool", async () => {
		const { hubPromise } = connectionHub(["https://ext.test"]);
		const hub = await hubPromise;
		const outcomes = await hub.addConnections([
			{ endpoint: "https://ext.test/mcp", groupId: "alice", name: "ext" },
		]);
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]?.ok).toBe(true);
		expect(hub.toolNames()).toContain("ext_echo");
	});

	it("keeps the service credential in transport custody only", async () => {
		const { audit, external, hubPromise, model } = connectionHub(["https://ext.test"]);
		const hub = await hubPromise;
		const connected = await hub.addConnection({
			endpoint: "https://ext.test/mcp",
			groupId: "alice",
			name: "ext",
			token: TOKEN,
		});
		expect(connected.ok).toBe(true);

		// The token reached the target server as a transport header.
		expect(
			external.requestHeaders.some(
				(headers) => headerValue(headers, "authorization") === `Bearer ${TOKEN}`,
			),
		).toBe(true);

		hub.grant("alice", "ext_echo");
		await hub.invokeTool("ext_echo", { text: "call the tool" }, "alice");
		await hub.invokeTool("askModel", { prompt: "what did the tool say?" }, "alice");

		// The token appears in no connection record, audit entry, or model-visible content.
		expect(JSON.stringify(hub.connections.list())).not.toContain(TOKEN);
		expect(JSON.stringify(audit.events)).not.toContain(TOKEN);
		expect(JSON.stringify(model.requests)).not.toContain(TOKEN);
	});
});
