import { describe, expect, it } from "bun:test";
import { createMCPClient } from "@tanstack/ai-mcp";
import { createHub } from "#/hub/mcp-server.ts";
import type { AskModelResult } from "#/hub/tools.ts";
import { hubFetchShim } from "./helpers/external-server.ts";
import { auditSink, blockOn, modelDouble, pipelineWith, staticReply } from "./helpers/fixtures.ts";

interface TextResult {
	content: Array<{ text?: string }>;
	isError?: boolean | undefined;
}

function resultText(result: unknown): string {
	const typed = result as TextResult;
	return (typed.content ?? []).map((part) => part.text ?? "").join("");
}

describe("standard MCP surface", () => {
	it("lets a standard MCP client list and invoke governed tools", async () => {
		const hub = await createHub({
			audit: auditSink(),
			model: modelDouble(() => staticReply("hi")),
			pipeline: pipelineWith([]),
		});
		const client = await createMCPClient({
			transport: {
				fetch: hubFetchShim((request) => hub.server("alice").fetch(request)),
				type: "http",
				url: "https://hub.test/mcp",
			},
		});

		const tools = await client.tools();
		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"addTodo",
			"askModel",
			"deleteAllTodos",
			"fetchUrl",
			"listTodos",
		]);

		const listed = await client.callTool("listTodos", {});
		expect(listed.isError ?? false).toBe(false);
		expect(resultText(listed)).toContain("todos");

		await client.close();
	});

	it("subjects client tool calls to the same tool-call governance", async () => {
		const model = modelDouble(() => staticReply("hi"));
		const hub = await createHub({
			audit: auditSink(),
			model,
			pipeline: pipelineWith([blockOn("BLOCKME")]),
		});
		const client = await createMCPClient({
			transport: {
				fetch: hubFetchShim((request) => hub.server("alice").fetch(request)),
				type: "http",
				url: "https://hub.test/mcp",
			},
		});

		const blocked = await client.callTool("askModel", { prompt: "BLOCKME please" });
		expect(blocked.isError ?? false).toBe(true);
		expect(resultText(blocked)).toContain("fixture-block");
		expect(model.requests).toHaveLength(0);

		const allowed = await client.callTool("askModel", { prompt: "a safe prompt" });
		expect(allowed.isError ?? false).toBe(false);
		expect(resultText(allowed)).toContain("hi");

		await client.close();
	});

	it("serves askModel results with the governed answer", async () => {
		const hub = await createHub({
			audit: auditSink(),
			model: modelDouble(() => staticReply("the governed answer")),
			pipeline: pipelineWith([]),
		});
		const client = await createMCPClient({
			transport: {
				fetch: hubFetchShim((request) => hub.server("alice").fetch(request)),
				type: "http",
				url: "https://hub.test/mcp",
			},
		});

		const called = await client.callTool("askModel", { prompt: "hello" });
		const text = resultText(called);
		expect(text).toContain("the governed answer");
		const parsed = JSON.parse(text) as AskModelResult;
		expect(parsed.status).toBe("ok");
		expect(parsed.verdict).toBe("allow");

		await client.close();
	});
});
