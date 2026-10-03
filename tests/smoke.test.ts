import { describe, expect, it } from "bun:test";
import { createHub } from "#/hub/mcp-server.ts";
import { auditSink, modelDouble, pipelineWith, staticReply } from "./helpers/fixtures.ts";

describe("hub smoke", () => {
	it("constructs the hub with doubles and exposes the governed catalog", async () => {
		const hub = await createHub({
			audit: auditSink(),
			model: modelDouble(() => staticReply("ok")),
			pipeline: pipelineWith([]),
		});
		expect(hub.toolNames().sort()).toEqual([
			"addTodo",
			"askModel",
			"deleteAllTodos",
			"fetchUrl",
			"listTodos",
		]);
	});

	it("runs a non-model tool without touching the model connection", async () => {
		const model = modelDouble(() => staticReply("should not be called"));
		const hub = await createHub({
			audit: auditSink(),
			model,
			pipeline: pipelineWith([]),
		});
		const outcome = await hub.invokeTool("listTodos", {}, "alice");
		expect(outcome.kind).toBe("executed");
		expect(model.requests).toHaveLength(0);
	});
});
