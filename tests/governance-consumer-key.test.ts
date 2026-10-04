import { describe, expect, it } from "bun:test";
import { createInMemoryAuditSink } from "#/control/audit.ts";
import type { CatalogEntry } from "#/hub/catalog.ts";
import { createToolGovernor } from "#/hub/governance.ts";
import { createGrantRegistry } from "#/hub/grants.ts";
import { createHub } from "#/hub/mcp-server.ts";
import { auditSink, blockOn, pipelineWith } from "./helpers/fixtures.ts";

function echoEntry(implementation: (args: unknown) => unknown): CatalogEntry {
	return {
		description: "echo fixture tool",
		grantedByDefault: true,
		implementation,
		inputSchema: {},
		name: "echo",
		source: "builtin",
	};
}

describe("governance consumer-key plumbing", () => {
	it("records consumerKey on ungranted tool denial", async () => {
		const audit = createInMemoryAuditSink();
		const grants = createGrantRegistry();
		grants.registerTool("echo", false);
		const governor = createToolGovernor({ audit, grants, pipeline: pipelineWith([]) });

		const outcome = await governor.governToolCall(
			echoEntry(() => ({ ok: true })),
			{},
			"alice",
			"alice-key",
		);

		expect(outcome.kind).toBe("refused");
		if (outcome.kind === "refused") {
			expect(outcome.rejection.kind).toBe("denied");
			expect(outcome.rejection.control).toBe("tool-authorization");
		}
		const denial = audit.events.find((event) => event.detail?.includes("ungranted"));
		expect(denial).toBeDefined();
		expect(denial?.consumerKey).toBe("alice-key");
		expect(denial?.subject).toBe("alice");
	});

	it("records consumerKey on args-inspection block", async () => {
		const audit = createInMemoryAuditSink();
		const grants = createGrantRegistry();
		grants.registerTool("echo", true);
		const governor = createToolGovernor({
			audit,
			grants,
			pipeline: pipelineWith([blockOn("BLOCKME")]),
		});

		let executed = false;
		const outcome = await governor.governToolCall(
			echoEntry(() => {
				executed = true;
				return { ok: true };
			}),
			{ text: "BLOCKME please" },
			"alice",
			"bob-key",
		);

		expect(outcome.kind).toBe("refused");
		expect(executed).toBe(false);
		const blocked = audit.events.find(
			(event) => event.kind === "interaction" && event.verdict === "block",
		);
		expect(blocked).toBeDefined();
		expect(blocked?.consumerKey).toBe("bob-key");
		expect(blocked?.subject).toBe("alice");
	});

	it("records consumerKey on result-inspection block", async () => {
		const audit = createInMemoryAuditSink();
		const grants = createGrantRegistry();
		grants.registerTool("echo", true);
		const governor = createToolGovernor({
			audit,
			grants,
			pipeline: pipelineWith([blockOn("SECRET", "fixture-block", "outbound")]),
		});

		const outcome = await governor.governToolCall(
			echoEntry(() => "contains SECRET value"),
			{},
			"alice",
			"carol-key",
		);

		expect(outcome.kind).toBe("refused");
		if (outcome.kind === "refused") {
			expect(outcome.rejection.kind).toBe("blocked");
		}
		const blocked = audit.events.find(
			(event) => event.kind === "interaction" && event.verdict === "block",
		);
		expect(blocked).toBeDefined();
		expect(blocked?.consumerKey).toBe("carol-key");
		expect(blocked?.subject).toBe("alice");
	});

	it("records consumerKey on unknown-tool path", async () => {
		const audit = auditSink();
		const hub = await createHub({ audit, pipeline: pipelineWith([]) });

		const outcome = await hub.invokeTool("does-not-exist", {}, "alice", "dave-key");

		expect(outcome.kind).toBe("refused");
		if (outcome.kind === "refused") {
			expect(outcome.rejection.control).toBe("tool-catalog");
		}
		const unknown = audit.events.find((event) => event.detail?.includes("unknown tool"));
		expect(unknown).toBeDefined();
		expect(unknown?.consumerKey).toBe("dave-key");
		expect(unknown?.subject).toBe("alice");
	});

	it("records consumerKey on tool-execution failure", async () => {
		const audit = createInMemoryAuditSink();
		const grants = createGrantRegistry();
		grants.registerTool("echo", true);
		const governor = createToolGovernor({ audit, grants, pipeline: pipelineWith([]) });

		const outcome = await governor.governToolCall(
			echoEntry(() => {
				throw new Error("boom");
			}),
			{},
			"alice",
			"erin-key",
		);

		expect(outcome.kind).toBe("refused");
		if (outcome.kind === "refused") {
			expect(outcome.rejection.kind).toBe("failed");
			expect(outcome.rejection.control).toBe("tool-execution");
		}
		const failure = audit.events.find((event) => event.kind === "failure");
		expect(failure).toBeDefined();
		expect(failure?.consumerKey).toBe("erin-key");
		expect(failure?.subject).toBe("alice");
	});

	it("defaults consumerKey to (none) when omitted", async () => {
		const audit = createInMemoryAuditSink();
		const grants = createGrantRegistry();
		grants.registerTool("echo", false);
		const governor = createToolGovernor({ audit, grants, pipeline: pipelineWith([]) });

		const outcome = await governor.governToolCall(
			echoEntry(() => ({ ok: true })),
			{},
			"alice",
		);

		expect(outcome.kind).toBe("refused");
		const denial = audit.events.find((event) => event.detail?.includes("ungranted"));
		expect(denial).toBeDefined();
		expect(denial?.consumerKey).toBe("(none)");
		expect(denial?.subject).toBe("alice");
	});
});
