import { describe, expect, it } from "bun:test";
import { createMCPClient } from "@tanstack/ai-mcp";
import { file, Glob } from "bun";
import { createHub } from "#/hub/mcp-server.ts";
import { hubFetchShim } from "./helpers/external-server.ts";
import { auditSink, blockOn, pipelineWith } from "./helpers/fixtures.ts";

interface TextResult {
	content: Array<{ text?: string }>;
	isError?: boolean | undefined;
}

function resultText(result: unknown): string {
	const typed = result as TextResult;
	return (typed.content ?? []).map((part) => part.text ?? "").join("");
}

const BUILTIN_TOOLS = ["addTodo", "deleteAllTodos", "fetchUrl", "listTodos"];
const MODEL_BYPASS_PATTERN = /createOpenAICompatibleConnection|#\/hub\/model\.ts/;

function surfaceClient(hub: Awaited<ReturnType<typeof createHub>>) {
	return createMCPClient({
		transport: {
			fetch: hubFetchShim((request) => hub.server("alice").fetch(request)),
			type: "http",
			url: "https://hub.test/mcp",
		},
	});
}

describe("standard MCP surface", () => {
	it("enumerates a tools-only catalog with no model-reaching tool", async () => {
		const hub = await createHub({
			audit: auditSink(),
			pipeline: pipelineWith([]),
		});
		expect(hub.toolNames().sort()).toEqual(BUILTIN_TOOLS);

		const client = await surfaceClient(hub);
		const tools = await client.tools();
		expect(tools.map((tool) => tool.name).sort()).toEqual(BUILTIN_TOOLS);

		await client.close();
	});

	it("subjects client tool calls to tool-call governance and serves governed results", async () => {
		const hub = await createHub({
			audit: auditSink(),
			pipeline: pipelineWith([blockOn("BLOCKME")]),
		});
		const client = await surfaceClient(hub);

		const blocked = await client.callTool("addTodo", { title: "BLOCKME please" });
		expect(blocked.isError ?? false).toBe(true);
		expect(resultText(blocked)).toContain("fixture-block");

		const allowed = await client.callTool("listTodos", {});
		expect(allowed.isError ?? false).toBe(false);
		expect(resultText(allowed)).toContain("todos");

		await client.close();
	});

	it("exposes no model-reaching route outside the hub", async () => {
		const glob = new Glob("**/*.ts");
		const offenders: string[] = [];
		for await (const routeFile of glob.scan({ cwd: "src/routes" })) {
			const text = await file(`src/routes/${routeFile}`).text();
			if (MODEL_BYPASS_PATTERN.test(text)) {
				offenders.push(routeFile);
			}
		}
		expect(offenders).toEqual([]);
	});
});
