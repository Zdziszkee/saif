import { describe, expect, it } from "bun:test";
import { createHub } from "#/hub/mcp-server.ts";
import { createOpenAICompatibleConnection, ModelConfigurationError } from "#/hub/model.ts";
import { auditSink, pipelineWith } from "./helpers/fixtures.ts";

describe("hub smoke", () => {
	it("constructs the hub with doubles and exposes the tools-only governed catalog", async () => {
		const hub = await createHub({
			audit: auditSink(),
			pipeline: pipelineWith([]),
		});
		expect(hub.toolNames().sort()).toEqual(["addTodo", "deleteAllTodos", "fetchUrl", "listTodos"]);
	});

	it("runs a tool through the governed catalog", async () => {
		const hub = await createHub({
			audit: auditSink(),
			pipeline: pipelineWith([]),
		});
		const outcome = await hub.invokeTool("listTodos", {}, "alice");
		expect(outcome.kind).toBe("executed");
	});

	it("reports a clear configuration error when the model connection is unconfigured", () => {
		let message = "";
		try {
			createOpenAICompatibleConnection({});
		} catch (error) {
			expect(error instanceof ModelConfigurationError).toBe(true);
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("MODEL_BASE_URL");
		expect(message).toContain("MODEL_NAME");
	});
});
