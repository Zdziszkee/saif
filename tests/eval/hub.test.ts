/**
 * Evaluation suite, part 8 — the MCP safety hub.
 *
 * The hub is the governed tool plane: builtin and connected tools run
 * under tool-call governance, unknown tools are refused, and every call
 * lands in the audit trail with its group attribution. Judges connecting
 * external MCP servers meet this same surface.
 */

import { describe, expect, it } from "bun:test";
import { createInMemoryAuditSink } from "#/control/audit.ts";
import { createHubConfig } from "#/hub/config.ts";
import { createHub } from "#/hub/mcp-server.ts";
import { blockOn, pipelineWith } from "../helpers/fixtures.ts";

function governedHub() {
	return createHub({
		audit: createInMemoryAuditSink(),
		config: createHubConfig({ identity: { knownGroups: ["hr", "manager"] } }),
		pipeline: pipelineWith([blockOn("EVIL")]),
	});
}

describe("eval: the hub serves a governed tool catalog", () => {
	it("lists the builtin tools", async () => {
		const hub = await governedHub();
		expect(hub.toolNames()).toContain("listTodos");
		expect(hub.toolNames()).toContain("addTodo");
	});

	it("runs a benign builtin tool call", async () => {
		const hub = await governedHub();
		const outcome = await hub.invokeTool("listTodos", {}, "hr");
		expect(outcome.kind).toBe("executed");
	});

	it("refuses an unknown tool with a defined rejection", async () => {
		const audit = createInMemoryAuditSink();
		const hub = await createHub({
			audit,
			config: createHubConfig({}),
			pipeline: pipelineWith([]),
		});
		const outcome = await hub.invokeTool("no-such-tool", {}, "hr");
		expect(outcome.kind).toBe("refused");
		if (outcome.kind === "refused") {
			expect(outcome.rejection.control).toBe("tool-catalog");
			expect(outcome.rejection.verdict).toBe("block");
		}
		expect(
			audit.events.some((event) => event.kind === "interaction" && event.groupId === "hr"),
		).toBe(true);
	});

	it("refuses a tool call the pipeline blocks", async () => {
		const hub = await governedHub();
		const outcome = await hub.invokeTool("addTodo", { title: "EVIL plan" }, "hr");
		expect(outcome.kind).toBe("refused");
		if (outcome.kind === "refused") {
			expect(outcome.rejection.verdict).toBe("block");
		}
	});

	it("runs a clean tool call through governance", async () => {
		const hub = await governedHub();
		const outcome = await hub.invokeTool("addTodo", { title: "buy milk" }, "hr");
		expect(outcome.kind).toBe("executed");
	});

	it("grants a tool to a group", async () => {
		const hub = await governedHub();
		hub.grant("hr", "listTodos");
		const outcome = await hub.invokeTool("listTodos", {}, "hr");
		expect(outcome.kind).toBe("executed");
	});

	it("builds an MCP server for a group", async () => {
		const hub = await governedHub();
		const server = hub.server("hr");
		expect(server).toBeDefined();
	});

	it("resolves identity from the hub config", async () => {
		const hub = await governedHub();
		expect(hub.identity.resolve("eval-user", "hr").ok).toBe(true);
		expect(hub.identity.resolve("eval-user", "ghost-group").ok).toBe(false);
	});
});
