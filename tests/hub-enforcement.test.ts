import { describe, expect, it } from "bun:test";
import { createHubConfig } from "#/hub/config.ts";
import { type GovernedLoopTool, runGovernedLoop } from "#/hub/loop.ts";
import { createHub } from "#/hub/mcp-server.ts";
import type { AskModelResult } from "#/hub/tools.ts";
import {
	auditSink,
	blockOn,
	modelDouble,
	pipelineWith,
	staticReply,
	toolCallReply,
} from "./helpers/fixtures.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function askModelResult(hub: Awaited<ReturnType<typeof createHub>>): Promise<AskModelResult> {
	const outcome = await hub.invokeTool("askModel", { prompt: "run the loop" }, "alice");
	if (outcome.kind !== "executed") {
		throw new Error(`expected executed, got ${outcome.kind}`);
	}
	return outcome.result as AskModelResult;
}

describe("tool-call enforcement modes", () => {
	it("tool-scoped: refuses the call with a tool error and the turn continues", async () => {
		const model = modelDouble((_request, index) =>
			index === 0 ? toolCallReply("addTodo", { title: "EVIL todo" }) : staticReply("all done"),
		);
		const hub = await createHub({
			audit: auditSink(),
			config: createHubConfig({ toolEnforcement: "tool" }),
			model,
			pipeline: pipelineWith([blockOn("EVIL")]),
		});

		const result = await askModelResult(hub);
		expect(result.status).toBe("ok");
		expect(result.answer).toBe("all done");
		expect(model.requests).toHaveLength(2);

		const secondRequest = model.requests[1];
		expect(secondRequest).toBeDefined();
		const toolMessage = secondRequest?.messages.find((message) => message.role === "tool");
		expect(toolMessage?.content).toContain("fixture-block");
	});

	it("turn-scoped: rejects the whole turn with the defined rejection", async () => {
		const model = modelDouble((_request, index) =>
			index === 0 ? toolCallReply("addTodo", { title: "EVIL todo" }) : staticReply("all done"),
		);
		const hub = await createHub({
			audit: auditSink(),
			config: createHubConfig({ toolEnforcement: "turn" }),
			model,
			pipeline: pipelineWith([blockOn("EVIL")]),
		});

		const result = await askModelResult(hub);
		expect(result.status).toBe("blocked");
		expect(result.verdict).toBe("block");
		expect(result.control).toBe("fixture-block");
		expect(model.requests).toHaveLength(1);
	});
});

describe("governed agentic loop budgets", () => {
	it("terminates on the request-count budget and records the over-budget verdict", async () => {
		const audit = auditSink();
		const model = modelDouble(() => toolCallReply("listTodos", {}));
		const hub = await createHub({
			audit,
			config: createHubConfig({ loop: { maxComputeMs: 5000, maxToolRounds: 3 } }),
			model,
			pipeline: pipelineWith([]),
		});

		const result = await askModelResult(hub);
		expect(result.status).toBe("over-budget");
		expect(result.verdict).toBe("block");
		expect(model.requests).toHaveLength(3);
		expect(audit.events.some((event) => event.kind === "budget")).toBe(true);
	});

	it("terminates on the compute-time budget", async () => {
		const slowTool: GovernedLoopTool = {
			execute: async () => {
				await sleep(30);
				return { kind: "executed", result: { done: true }, resultVerdict: "allow" };
			},
			spec: { description: "slow fixture tool", inputSchema: {}, name: "slow" },
		};
		const model = modelDouble(() => toolCallReply("slow"));

		const result = await runGovernedLoop("go", {
			budgets: { maxComputeMs: 5, maxToolRounds: 100 },
			enforcement: "tool",
			model,
			tools: [slowTool],
		});
		expect(result.kind).toBe("over-budget");
		if (result.kind === "over-budget") {
			expect(result.verdict).toBe("block");
		}
	});

	it("feeds governed tool results back to the model until the final answer", async () => {
		const noopTool: GovernedLoopTool = {
			execute: () =>
				Promise.resolve({ kind: "executed", result: { ok: true }, resultVerdict: "allow" }),
			spec: { description: "noop fixture tool", inputSchema: {}, name: "noop" },
		};
		const model = modelDouble((_request, index) =>
			index === 0 ? toolCallReply("noop") : staticReply("final"),
		);

		const result = await runGovernedLoop("go", {
			budgets: { maxComputeMs: 5000, maxToolRounds: 5 },
			enforcement: "tool",
			model,
			tools: [noopTool],
		});
		expect(result.kind).toBe("answer");
		if (result.kind === "answer") {
			expect(result.answer).toBe("final");
			expect(result.rounds).toBe(2);
		}
	});
});
