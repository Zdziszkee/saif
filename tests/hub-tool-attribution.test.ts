import { describe, expect, it } from "bun:test";
import { createMCPClient } from "@tanstack/ai-mcp";
import { createInMemoryAuditSink } from "#/control/audit.ts";
import type { CatalogEntry } from "#/hub/catalog.ts";
import { createToolGovernor } from "#/hub/governance.ts";
import { createGrantRegistry } from "#/hub/grants.ts";
import { createHub } from "#/hub/mcp-server.ts";
import { hubFetchShim } from "./helpers/external-server.ts";
import { auditSink, blockOn, blockSubject, pipelineWith } from "./helpers/fixtures.ts";

function echoEntry(): CatalogEntry {
	return {
		description: "echo fixture tool",
		grantedByDefault: true,
		implementation: () => "fine",
		inputSchema: {},
		name: "echo",
		source: "builtin",
	};
}

describe("hub tool-call attribution", () => {
	it("unknown-tool refusal defaults consumerKey to (none) when omitted", async () => {
		const audit = auditSink();
		const hub = await createHub({ audit, pipeline: pipelineWith([]) });

		const outcome = await hub.invokeTool("does-not-exist", {}, "alice");

		expect(outcome.kind).toBe("refused");
		if (outcome.kind === "refused") {
			expect(outcome.rejection.control).toBe("tool-catalog");
		}
		const unknown = audit.events.find((event) => event.detail?.includes("unknown tool"));
		expect(unknown).toBeDefined();
		expect(unknown?.consumerKey).toBe("(none)");
		expect(unknown?.subject).toBe("alice");
	});

	it("granted invokeTool path forwards consumerKey to governed audit", async () => {
		const audit = auditSink();
		const hub = await createHub({ audit, pipeline: pipelineWith([]) });

		const outcome = await hub.invokeTool("listTodos", {}, "alice", "alice-key");

		expect(outcome.kind).toBe("executed");
		const calls = audit.events.filter(
			(event) => event.seam === "mcp-tool" && event.subject === "alice",
		);
		expect(calls.length).toBeGreaterThan(0);
		for (const event of calls) {
			expect(event.consumerKey).toBe("alice-key");
		}
	});

	it("served surface forwards subject and consumerKey to governed audit", async () => {
		const audit = auditSink();
		const hub = await createHub({ audit, pipeline: pipelineWith([blockOn("BLOCKME")]) });
		const client = await createMCPClient({
			transport: {
				fetch: hubFetchShim((request) => hub.server("alice", "alice-key").fetch(request)),
				type: "http",
				url: "https://hub.test/mcp",
			},
		});

		const blocked = await client.callTool("addTodo", { title: "BLOCKME please" });

		expect(blocked.isError ?? false).toBe(true);
		const denial = audit.events.find(
			(event) =>
				event.kind === "interaction" && event.verdict === "block" && event.subject === "alice",
		);
		expect(denial).toBeDefined();
		expect(denial?.consumerKey).toBe("alice-key");
		await client.close();
	});

	it("served surface defaults to anonymous subject and (none) consumerKey", async () => {
		const audit = auditSink();
		const hub = await createHub({ audit, pipeline: pipelineWith([]) });
		const client = await createMCPClient({
			transport: {
				fetch: hubFetchShim((request) => hub.server().fetch(request)),
				type: "http",
				url: "https://hub.test/mcp",
			},
		});

		const result = await client.callTool("listTodos", {});

		expect(result.isError ?? false).toBe(false);
		const calls = audit.events.filter((event) => event.seam === "mcp-tool");
		expect(calls.length).toBeGreaterThan(0);
		for (const event of calls) {
			expect(event.subject).toBe("anonymous");
			expect(event.consumerKey).toBe("(none)");
		}
		await client.close();
	});

	it("parallel governToolCall keeps verdicts and audit attributed per consumer", async () => {
		const audit = createInMemoryAuditSink();
		const grants = createGrantRegistry();
		grants.registerTool("echo", true);
		const governor = createToolGovernor({
			audit,
			grants,
			pipeline: pipelineWith([blockSubject("bob", "MARK")]),
		});
		const entry = echoEntry();

		const [aliceOutcome, bobOutcome] = await Promise.all([
			governor.governToolCall(entry, { text: "MARK payload" }, "alice", "alice-key"),
			governor.governToolCall(entry, { text: "MARK payload" }, "bob", "bob-key"),
		]);

		expect(aliceOutcome.kind).toBe("executed");
		expect(bobOutcome.kind).toBe("refused");
		expect(audit.events.length).toBeGreaterThan(0);
		for (const event of audit.events) {
			expect(
				(event.consumerKey === "alice-key" && event.subject === "alice") ||
					(event.consumerKey === "bob-key" && event.subject === "bob"),
			).toBe(true);
		}
		expect(
			audit.events.some((event) => event.consumerKey === "alice-key" && event.subject === "alice"),
		).toBe(true);
		expect(
			audit.events.some((event) => event.consumerKey === "bob-key" && event.subject === "bob"),
		).toBe(true);
	});
});
