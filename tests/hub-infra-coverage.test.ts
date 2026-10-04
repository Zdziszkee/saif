import { describe, expect, it } from "bun:test";
import { toolDefinition } from "@tanstack/ai";
import { createMCPServer } from "@tanstack/ai-mcp/server";
import { z } from "zod";
import { createToolCatalog, toJsonSchema } from "#/hub/catalog.ts";
import { createHubConfig, isEgressAllowed } from "#/hub/config.ts";
import { createHubConnections } from "#/hub/connections.ts";
import { createGrantRegistry } from "#/hub/grants.ts";
import { runGovernedLoop } from "#/hub/loop.ts";
import { createHub } from "#/hub/mcp-server.ts";
import type { ModelReply } from "#/hub/model.ts";
import { createExternalServer } from "./helpers/external-server.ts";
import { auditSink, modelDouble, pipelineWith, staticReply } from "./helpers/fixtures.ts";

function shimFetch(target: (request: Request) => Promise<Response>): typeof fetch {
	return ((input: RequestInfo | URL, init?: RequestInit) =>
		target(new Request(input, init))) as typeof fetch;
}

function usage(): ModelReply["usage"] {
	return { completionTokens: 1, promptTokens: 1, totalTokens: 2 };
}

describe("hub config egress edges", () => {
	it("rejects a malformed endpoint URL", () => {
		expect(isEgressAllowed("not-a-url", ["https://ext.test"])).toBe(false);
	});

	it("matches a wildcard entry against the full href", () => {
		expect(isEgressAllowed("https://a.test/mcp", ["https://*.test/*"])).toBe(true);
	});

	it("matches a wildcard entry against the origin", () => {
		expect(isEgressAllowed("https://a.test/mcp", ["https://*.test"])).toBe(true);
	});

	it("matches an entry that normalizes to the endpoint href", () => {
		expect(isEgressAllowed("https://ext.test/mcp", ["https://EXT.test/mcp"])).toBe(true);
	});

	it("ignores an allowlist entry that is not a URL", () => {
		expect(isEgressAllowed("https://ext.test/mcp", [":::not-a-url"])).toBe(false);
	});
});

describe("hub catalog edges", () => {
	it("falls back to an empty schema for non-object input", () => {
		expect(toJsonSchema(42)).toEqual({});
		expect(toJsonSchema("schema")).toEqual({});
		expect(toJsonSchema(null)).toEqual({});
	});

	it("stores an empty schema when registering a non-object schema", async () => {
		const catalog = createToolCatalog({ audit: auditSink(), pipeline: pipelineWith([]) });

		const admitted = await catalog.register({
			description: "weird schema tool",
			grantedByDefault: false,
			implementation: () => ({ done: true }),
			inputSchema: 42,
			name: "weird",
			source: "builtin",
		});

		expect(admitted.ok).toBe(true);
		expect(catalog.get("weird")?.inputSchema).toEqual({});
	});

	it("removes a registered tool", async () => {
		const catalog = createToolCatalog({ audit: auditSink(), pipeline: pipelineWith([]) });
		await catalog.register({
			description: "removable",
			grantedByDefault: false,
			implementation: () => ({ done: true }),
			inputSchema: {},
			name: "removable",
			source: "builtin",
		});

		catalog.remove("removable");

		expect(catalog.get("removable")).toBeUndefined();
	});

	it("ignores removal of an unknown tool", () => {
		const catalog = createToolCatalog({ audit: auditSink(), pipeline: pipelineWith([]) });

		catalog.remove("missing");

		expect(catalog.snapshot()).toHaveLength(0);
	});
});

describe("hub grant edges", () => {
	it("revokes an explicit grant", () => {
		const grants = createGrantRegistry();

		grants.grant("alice", "tool-a");
		grants.revoke("alice", "tool-a");

		expect(grants.isGranted("alice", "tool-a")).toBe(false);
	});

	it("revokes a default grant via override", () => {
		const grants = createGrantRegistry();
		grants.registerTool("tool-b", true);
		expect(grants.isGranted("alice", "tool-b")).toBe(true);

		grants.revoke("alice", "tool-b");

		expect(grants.isGranted("alice", "tool-b")).toBe(false);
	});
});

describe("hub loop edges", () => {
	it("sends the system prompt as the first message", async () => {
		const model = modelDouble(() => staticReply("done"));

		const result = await runGovernedLoop("hi", {
			budgets: { maxComputeMs: 5000, maxToolRounds: 5 },
			enforcement: "tool",
			model,
			systemPrompt: "be brief",
			tools: [],
		});

		expect(result.kind).toBe("answer");
		expect(model.requests[0]?.messages[0]).toEqual({ content: "be brief", role: "system" });
	});

	it("records an unknown tool call as blocked and continues", async () => {
		const model = modelDouble((_request, index) =>
			index === 0
				? {
						finishReason: "tool_calls",
						text: "",
						toolCalls: [{ arguments: "{}", id: "call_missing", name: "missing" }],
						usage: usage(),
					}
				: staticReply("done"),
		);

		const result = await runGovernedLoop("hi", {
			budgets: { maxComputeMs: 5000, maxToolRounds: 5 },
			enforcement: "tool",
			model,
			tools: [],
		});

		expect(result.kind).toBe("answer");
		const toolMessage = model.requests[1]?.messages.find((message) => message.role === "tool");
		expect(toolMessage?.content).toContain("blocked");
	});

	it("falls back to an empty object for malformed tool arguments", async () => {
		let seen: unknown = "unset";
		const model = modelDouble((_request, index) =>
			index === 0
				? {
						finishReason: "tool_calls",
						text: "",
						toolCalls: [{ arguments: "not-json{{{", id: "call_t", name: "t" }],
						usage: usage(),
					}
				: staticReply("done"),
		);

		const result = await runGovernedLoop("hi", {
			budgets: { maxComputeMs: 5000, maxToolRounds: 5 },
			enforcement: "tool",
			model,
			tools: [
				{
					execute: (args) => {
						seen = args;
						return Promise.resolve({
							kind: "executed",
							result: { ok: true },
							resultVerdict: "allow",
						});
					},
					spec: { description: "t tool", inputSchema: {}, name: "t" },
				},
			],
		});

		expect(result.kind).toBe("answer");
		expect(seen).toEqual({});
	});
});

describe("hub connections edges", () => {
	it("rejects a duplicate connection name", async () => {
		const external = createExternalServer();
		const hub = await createHub({
			audit: auditSink(),
			config: createHubConfig({ egressAllowlist: ["https://ext.test"] }),
			fetch: external.fetch,
			pipeline: pipelineWith([]),
		});
		const first = await hub.addConnection({
			endpoint: "https://ext.test/mcp",
			name: "ext",
			subject: "alice",
		});
		expect(first.ok).toBe(true);

		const second = await hub.addConnection({
			endpoint: "https://ext.test/mcp",
			name: "ext",
			subject: "alice",
		});

		expect(second.ok).toBe(false);
		if (!second.ok) {
			expect(second.error).toContain("already in use");
		}
		expect(hub.connections.list()).toHaveLength(1);
	});

	it("rejects the connection when admission throws", async () => {
		const external = createExternalServer();
		const connections = createHubConnections({
			audit: auditSink(),
			config: createHubConfig({ egressAllowlist: ["https://ext.test"] }),
			fetch: external.fetch,
			grants: createGrantRegistry(),
			registerTool: () => Promise.reject(new Error("boom-admission")),
		});

		const outcome = await connections.connect({
			endpoint: "https://ext.test/mcp",
			name: "ext",
			subject: "alice",
		});

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.error).toContain("boom-admission");
		}
		expect(connections.list()).toHaveLength(0);
	});

	it("maps a non-Error admission failure to its string form", async () => {
		const external = createExternalServer();
		const connections = createHubConnections({
			audit: auditSink(),
			config: createHubConfig({ egressAllowlist: ["https://ext.test"] }),
			fetch: external.fetch,
			grants: createGrantRegistry(),
			registerTool: () => Promise.reject("string-failure"),
		});

		const outcome = await connections.connect({
			endpoint: "https://ext.test/mcp",
			name: "ext",
			subject: "alice",
		});

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.error).toBe("string-failure");
		}
	});

	it("returns rejections when every batch endpoint is blocked", async () => {
		const external = createExternalServer();
		const hub = await createHub({
			audit: auditSink(),
			config: createHubConfig({ egressAllowlist: ["https://allowed.test"] }),
			fetch: external.fetch,
			pipeline: pipelineWith([]),
		});

		const outcomes = await hub.addConnections([
			{ endpoint: "https://nope.test/mcp", name: "a", subject: "alice" },
			{ endpoint: "https://alsono.test/mcp", name: "b", subject: "alice" },
		]);

		expect(outcomes).toHaveLength(2);
		expect(outcomes.every((outcome) => !outcome.ok)).toBe(true);
		expect(hub.connections.list()).toHaveLength(0);
	});

	it("keeps the blocked rejection and connects the allowed entry in a mixed batch", async () => {
		const external = createExternalServer();
		const hub = await createHub({
			audit: auditSink(),
			config: createHubConfig({ egressAllowlist: ["https://ext.test"] }),
			fetch: external.fetch,
			pipeline: pipelineWith([]),
		});

		const outcomes = await hub.addConnections([
			{ endpoint: "https://blocked.test/mcp", name: "blocked", subject: "alice" },
			{ endpoint: "https://ext.test/mcp", name: "ext", subject: "alice" },
		]);

		expect(outcomes).toHaveLength(2);
		expect(outcomes[0]?.ok).toBe(false);
		expect(outcomes[1]?.ok).toBe(true);
		expect(hub.connections.list().map((connection) => connection.name)).toEqual(["ext"]);
	});

	it("removes an established connection", async () => {
		const external = createExternalServer();
		const hub = await createHub({
			audit: auditSink(),
			config: createHubConfig({ egressAllowlist: ["https://ext.test"] }),
			fetch: external.fetch,
			pipeline: pipelineWith([]),
		});
		await hub.addConnection({ endpoint: "https://ext.test/mcp", name: "ext", subject: "alice" });
		expect(hub.connections.list()).toHaveLength(1);

		await hub.connections.remove("ext");

		expect(hub.connections.list()).toHaveLength(0);
	});

	it("ignores removal of an unknown connection", async () => {
		const external = createExternalServer();
		const hub = await createHub({
			audit: auditSink(),
			config: createHubConfig({ egressAllowlist: ["https://ext.test"] }),
			fetch: external.fetch,
			pipeline: pipelineWith([]),
		});

		await hub.connections.remove("missing");

		expect(hub.connections.list()).toHaveLength(0);
	});

	it("parses a single JSON text payload from a connected tool", async () => {
		const server = createMCPServer({
			name: "json-text-server",
			tools: [
				toolDefinition({
					description: "json text",
					inputSchema: z.object({}),
					name: "jsontext",
				}).server(() => '{"echoed":"json"}'),
			],
			version: "1.0.0",
		});
		const hub = await createHub({
			audit: auditSink(),
			config: createHubConfig({ egressAllowlist: ["https://json.test"] }),
			fetch: shimFetch((request) => server.fetch(request)),
			pipeline: pipelineWith([]),
		});
		const connected = await hub.addConnection({
			endpoint: "https://json.test/mcp",
			name: "j",
			subject: "alice",
		});
		expect(connected.ok).toBe(true);
		hub.grant("alice", "j_jsontext");

		const outcome = await hub.invokeTool("j_jsontext", {}, "alice");

		expect(outcome.kind).toBe("executed");
		if (outcome.kind === "executed") {
			expect(outcome.result).toEqual({ echoed: "json" });
		}
	});

	it("returns a single plain-text payload unchanged", async () => {
		const server = createMCPServer({
			name: "plain-text-server",
			tools: [
				toolDefinition({
					description: "plain text",
					inputSchema: z.object({}),
					name: "plain",
				}).server(() => "just text"),
			],
			version: "1.0.0",
		});
		const hub = await createHub({
			audit: auditSink(),
			config: createHubConfig({ egressAllowlist: ["https://plain.test"] }),
			fetch: shimFetch((request) => server.fetch(request)),
			pipeline: pipelineWith([]),
		});
		await hub.addConnection({ endpoint: "https://plain.test/mcp", name: "p", subject: "alice" });
		hub.grant("alice", "p_plain");

		const outcome = await hub.invokeTool("p_plain", {}, "alice");

		expect(outcome.kind).toBe("executed");
		if (outcome.kind === "executed") {
			expect(outcome.result).toBe("just text");
		}
	});

	it("returns every text part when a connected tool yields several", async () => {
		const server = createMCPServer({
			name: "multi-text-server",
			tools: [
				toolDefinition({
					description: "multi text",
					inputSchema: z.object({}),
					name: "multi",
				}).server(() => ({
					content: [
						{ text: "a", type: "text" },
						{ text: "b", type: "text" },
					],
				})),
			],
			version: "1.0.0",
		});
		const hub = await createHub({
			audit: auditSink(),
			config: createHubConfig({ egressAllowlist: ["https://multi.test"] }),
			fetch: shimFetch((request) => server.fetch(request)),
			pipeline: pipelineWith([]),
		});
		await hub.addConnection({ endpoint: "https://multi.test/mcp", name: "m", subject: "alice" });
		hub.grant("alice", "m_multi");

		const outcome = await hub.invokeTool("m_multi", {}, "alice");

		expect(outcome.kind).toBe("executed");
		if (outcome.kind === "executed") {
			expect(outcome.result).toEqual(["a", "b"]);
		}
	});

	it("executes a pooled tool through its owning client", async () => {
		const external = createExternalServer();
		const hub = await createHub({
			audit: auditSink(),
			config: createHubConfig({ egressAllowlist: ["https://ext.test"] }),
			fetch: external.fetch,
			pipeline: pipelineWith([]),
		});
		const outcomes = await hub.addConnections([
			{ endpoint: "https://ext.test/mcp", name: "ext", subject: "alice" },
		]);
		expect(outcomes[0]?.ok).toBe(true);
		hub.grant("alice", "ext_echo");

		const outcome = await hub.invokeTool("ext_echo", { text: "pooled" }, "alice");

		expect(outcome.kind).toBe("executed");
		if (outcome.kind === "executed") {
			expect(outcome.result).toEqual({ echoed: "pooled" });
		}
	});

	it("covers the default-grant registration path", () => {
		const grants = createGrantRegistry();

		grants.registerTool("default-on", true);

		expect(grants.isGranted("alice", "default-on")).toBe(true);
		expect(grants.isGranted("bob", "default-on")).toBe(true);
	});
});
