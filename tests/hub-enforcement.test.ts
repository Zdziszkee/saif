import { describe, expect, it } from "bun:test";
import { createHubConfig } from "#/hub/config.ts";
import { type GovernedLoopTool, runGovernedLoop } from "#/hub/loop.ts";
import { createHub } from "#/hub/mcp-server.ts";
import {
	auditSink,
	blockOn,
	modelDouble,
	pipelineWith,
	staticReply,
	toolCallReply,
} from "./helpers/fixtures.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const LOOP_BUDGETS = { maxComputeMs: 5000, maxToolRounds: 5 };

function governedTool(hub: Awaited<ReturnType<typeof createHub>>, name: string): GovernedLoopTool {
	return {
		execute: (args) => hub.invokeTool(name, args, "alice"),
		spec: { description: `${name} fixture tool`, inputSchema: {}, name },
	};
}

describe("tool-call enforcement modes", () => {
	it("tool-scoped: refuses the call with a tool error and the turn continues", async () => {
		const model = modelDouble((_request, index) =>
			index === 0 ? toolCallReply("addTodo", { title: "EVIL todo" }) : staticReply("all done"),
		);
		const hub = await createHub({
			audit: auditSink(),
			config: createHubConfig({ toolEnforcement: "tool" }),
			pipeline: pipelineWith([blockOn("EVIL")]),
		});

		const result = await runGovernedLoop("run the loop", {
			budgets: LOOP_BUDGETS,
			enforcement: hub.config.toolEnforcement,
			model,
			tools: [governedTool(hub, "addTodo")],
		});
		expect(result.kind).toBe("answer");
		if (result.kind === "answer") {
			expect(result.answer).toBe("all done");
		}
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
			pipeline: pipelineWith([blockOn("EVIL")]),
		});

		const result = await runGovernedLoop("run the loop", {
			budgets: LOOP_BUDGETS,
			enforcement: hub.config.toolEnforcement,
			model,
			tools: [governedTool(hub, "addTodo")],
		});
		expect(result.kind).toBe("turn-rejected");
		if (result.kind === "turn-rejected") {
			expect(result.rejection.control).toBe("fixture-block");
			expect(result.rejection.verdict).toBe("block");
		}
		expect(model.requests).toHaveLength(1);
	});
});

describe("governed agentic loop budgets", () => {
	it("terminates on the request-count budget and reports the over-budget verdict", async () => {
		const model = modelDouble(() => toolCallReply("listTodos", {}));
		const hub = await createHub({
			audit: auditSink(),
			pipeline: pipelineWith([]),
		});

		const result = await runGovernedLoop("go", {
			budgets: { maxComputeMs: 5000, maxToolRounds: 3 },
			enforcement: hub.config.toolEnforcement,
			model,
			tools: [governedTool(hub, "listTodos")],
		});
		expect(result.kind).toBe("over-budget");
		if (result.kind === "over-budget") {
			expect(result.verdict).toBe("block");
		}
		expect(model.requests).toHaveLength(3);
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
