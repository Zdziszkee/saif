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

/**
 * Prompt-plane gateway seam (task 14.x): `POST /v1/chat/completions` reaches
 * the model through the hub's OpenAI-compatible transport, governed by the
 * shared pipeline (identity -> usage-limit -> deterministic -> semantic ->
 * forward). D10 still bans model-reaching MCP-serving routes — this is the
 * only route allowed to name the model transport, and only because every
 * prompt and (non-stream) answer flows through `guardInteraction()`.
 */
const GATEWAY_ALLOWLIST = new Set(["v1.chat-completions.ts"]);

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
			if (MODEL_BYPASS_PATTERN.test(text) && !GATEWAY_ALLOWLIST.has(routeFile)) {
				offenders.push(routeFile);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("holds the allowlisted gateway seam to pipeline governance", async () => {
		for (const routeFile of GATEWAY_ALLOWLIST) {
			// biome-ignore lint/performance/noAwaitInLoops: allowlist reads run in order, one file each
			const text = await file(`src/routes/${routeFile}`).text();
			expect(text).toContain("guardInteraction");
		}
	});
});
