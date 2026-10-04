import { describe, expect, it } from "bun:test";
import { definedConfirmation } from "#/hub/governance.ts";
import { createGrantRegistry } from "#/hub/grants.ts";
import { createHub } from "#/hub/mcp-server.ts";
import { createToolPolicyRegistry, type ToolPolicy } from "#/hub/tool-policy.ts";
import type { ToolUsageRecord } from "#/hub/tool-usage.ts";
import { auditSink, pipelineWith } from "./helpers/fixtures.ts";

type TestHub = Awaited<ReturnType<typeof createHub>>;

let titleSequence = 0;

function uniqueTitle(prefix: string): string {
	titleSequence += 1;
	return `${prefix}-${titleSequence}`;
}

function policyRegistry(tools: ToolPolicy["tools"]) {
	const registry = createToolPolicyRegistry();
	registry.update({
		policy: { tools, version: "1" },
		version: "1",
	});
	return registry;
}

async function policyHub(tools: ToolPolicy["tools"]) {
	const audit = auditSink();
	const records: ToolUsageRecord[] = [];
	const hub = await createHub({
		audit,
		pipeline: pipelineWith([]),
		toolAccess: policyRegistry(tools),
		toolUsage: (record) => {
			records.push(record);
		},
	});
	return { audit, hub, records };
}

async function todoTitles(hub: TestHub, groupId: string): Promise<string[]> {
	const outcome = await hub.invokeTool("listTodos", {}, groupId);
	if (outcome.kind !== "executed") {
		throw new Error(`expected listTodos to execute, got ${outcome.kind}`);
	}
	const result = outcome.result as { todos: Array<{ title: string }> };
	return result.todos.map((todo) => todo.title);
}

async function todoCount(hub: TestHub, groupId: string): Promise<number> {
	return (await todoTitles(hub, groupId)).length;
}

describe("tool-policy authorization", () => {
	it("denies an unlisted tool for every group", async () => {
		const { hub } = await policyHub({
			addTodo: { allowedGroups: ["manager"], requireConfirm: false },
		});

		const managerOutcome = await hub.invokeTool("listTodos", {}, "manager");
		expect(managerOutcome.kind).toBe("refused");
		if (managerOutcome.kind === "refused") {
			expect(managerOutcome.rejection).toEqual({
				control: "tool-authorization",
				kind: "denied",
				verdict: "block",
			});
		}

		const hrOutcome = await hub.invokeTool("listTodos", {}, "hr");
		expect(hrOutcome.kind).toBe("refused");
		if (hrOutcome.kind === "refused") {
			expect(hrOutcome.rejection).toEqual({
				control: "tool-authorization",
				kind: "denied",
				verdict: "block",
			});
		}
	});

	it("allows a listed group and denies a non-listed group", async () => {
		const title = uniqueTitle("listed-group");
		const { hub } = await policyHub({
			addTodo: { allowedGroups: ["manager"], requireConfirm: false },
		});

		const allowed = await hub.invokeTool("addTodo", { title }, "manager");
		expect(allowed.kind).toBe("executed");

		const denied = await hub.invokeTool("addTodo", { title }, "hr");
		expect(denied.kind).toBe("refused");
		if (denied.kind === "refused") {
			expect(denied.rejection.control).toBe("tool-authorization");
			expect(denied.rejection.verdict).toBe("block");
		}
	});

	it("lets an explicit grant() win over a policy deny", async () => {
		const title = uniqueTitle("grant-wins");
		const { hub } = await policyHub({
			addTodo: { allowedGroups: ["manager"], requireConfirm: false },
		});

		hub.grant("hr", "addTodo");
		const outcome = await hub.invokeTool("addTodo", { title }, "hr");
		expect(outcome.kind).toBe("executed");
	});

	it("lets explicit revoke() win over a policy allow at the grant registry", () => {
		const grants = createGrantRegistry({
			access: policyRegistry({
				addTodo: { allowedGroups: ["manager"], requireConfirm: false },
			}),
		});
		expect(grants.isGranted("hr", "addTodo")).toBe(false);
		expect(grants.isGranted("manager", "addTodo")).toBe(true);

		grants.revoke("manager", "addTodo");
		expect(grants.isGranted("manager", "addTodo")).toBe(false);

		grants.grant("hr", "addTodo");
		expect(grants.isGranted("hr", "addTodo")).toBe(true);
	});

	it("refuses an unknown tool name via tool-catalog", async () => {
		const { hub } = await policyHub({
			addTodo: { allowedGroups: ["manager"], requireConfirm: false },
		});

		hub.grant("manager", "no-such-tool");
		const outcome = await hub.invokeTool("no-such-tool", {}, "manager");
		expect(outcome.kind).toBe("refused");
		if (outcome.kind === "refused") {
			expect(outcome.rejection.control).toBe("tool-catalog");
			expect(outcome.rejection.verdict).toBe("block");
		}
	});
});

describe("tool confirmation", () => {
	it("issues a confirmation token instead of executing a requireConfirm tool", async () => {
		const seed = uniqueTitle("confirm-seed");
		const { audit, hub } = await policyHub({
			addTodo: { allowedGroups: ["manager"], requireConfirm: false },
			deleteAllTodos: { allowedGroups: ["manager"], requireConfirm: true },
			listTodos: { allowedGroups: ["manager"], requireConfirm: false },
		});
		const seeded = await hub.invokeTool("addTodo", { title: seed }, "manager");
		expect(seeded.kind).toBe("executed");

		const first = await hub.invokeTool("deleteAllTodos", {}, "manager");
		expect(first.kind).toBe("confirmation-required");
		if (first.kind === "confirmation-required") {
			expect(first.confirmation.tool).toBe("deleteAllTodos");
			expect(first.confirmation.token.length).toBeGreaterThan(0);
			const payload = JSON.parse(definedConfirmation(first.confirmation)) as Record<
				string,
				unknown
			>;
			expect(payload).toEqual({
				confirmationToken: first.confirmation.token,
				control: "tool-confirmation",
				error: "confirmation-required",
				tool: "deleteAllTodos",
				verdict: "escalate",
			});
		}

		expect(await todoTitles(hub, "manager")).toContain(seed);
		expect(audit.events.some((event) => event.controlId === "tool-confirmation")).toBe(true);
	});

	it("executes the stored args on confirmation and drops smuggled keys", async () => {
		const seed = uniqueTitle("stored-args-seed");
		const { hub } = await policyHub({
			addTodo: { allowedGroups: ["manager"], requireConfirm: false },
			deleteAllTodos: { allowedGroups: ["manager"], requireConfirm: true },
			listTodos: { allowedGroups: ["manager"], requireConfirm: false },
		});
		const seeded = await hub.invokeTool("addTodo", { title: seed }, "manager");
		expect(seeded.kind).toBe("executed");
		const before = await todoCount(hub, "manager");
		expect(before).toBeGreaterThan(0);

		const first = await hub.invokeTool("deleteAllTodos", {}, "manager");
		expect(first.kind).toBe("confirmation-required");
		if (first.kind !== "confirmation-required") {
			return;
		}
		const confirmed = await hub.invokeTool(
			"deleteAllTodos",
			{ confirm: first.confirmation.token, injected: true },
			"manager",
		);
		expect(confirmed.kind).toBe("executed");
		if (confirmed.kind === "executed") {
			expect(confirmed.result).toEqual({ deleted: before });
		}
		expect(await todoTitles(hub, "manager")).toEqual([]);
	});

	it("runs the stored args, not the confirming call's args", async () => {
		const evil = uniqueTitle("evil");
		const real = uniqueTitle("real");
		const { hub } = await policyHub({
			addTodo: { allowedGroups: ["manager"], requireConfirm: true },
			listTodos: { allowedGroups: ["manager"], requireConfirm: false },
		});

		const first = await hub.invokeTool("addTodo", { title: real }, "manager");
		expect(first.kind).toBe("confirmation-required");
		if (first.kind !== "confirmation-required") {
			return;
		}
		const confirmed = await hub.invokeTool(
			"addTodo",
			{ confirm: first.confirmation.token, title: evil },
			"manager",
		);
		expect(confirmed.kind).toBe("executed");
		if (confirmed.kind === "executed") {
			expect(confirmed.result).toEqual({ id: expect.any(Number), title: real });
		}

		const titles = await todoTitles(hub, "manager");
		expect(titles).toContain(real);
		expect(titles).not.toContain(evil);
	});

	it("treats a confirmation token as single-use", async () => {
		const title = uniqueTitle("single-use");
		const { hub } = await policyHub({
			addTodo: { allowedGroups: ["manager"], requireConfirm: true },
			listTodos: { allowedGroups: ["manager"], requireConfirm: false },
		});

		const first = await hub.invokeTool("addTodo", { title }, "manager");
		expect(first.kind).toBe("confirmation-required");
		if (first.kind !== "confirmation-required") {
			return;
		}
		const confirmed = await hub.invokeTool(
			"addTodo",
			{ confirm: first.confirmation.token },
			"manager",
		);
		expect(confirmed.kind).toBe("executed");
		const afterFirstUse = await todoCount(hub, "manager");

		const replay = await hub.invokeTool(
			"addTodo",
			{ confirm: first.confirmation.token },
			"manager",
		);
		expect(replay.kind).toBe("confirmation-required");
		expect(await todoCount(hub, "manager")).toBe(afterFirstUse);
	});

	it("refuses a confirmation token presented by a different group", async () => {
		const seed = uniqueTitle("cross-group-seed");
		const { hub } = await policyHub({
			addTodo: { allowedGroups: ["manager"], requireConfirm: false },
			deleteAllTodos: { allowedGroups: ["hr", "manager"], requireConfirm: true },
			listTodos: { allowedGroups: ["hr", "manager"], requireConfirm: false },
		});
		const seeded = await hub.invokeTool("addTodo", { title: seed }, "manager");
		expect(seeded.kind).toBe("executed");
		const before = await todoCount(hub, "manager");

		const first = await hub.invokeTool("deleteAllTodos", {}, "manager");
		expect(first.kind).toBe("confirmation-required");
		if (first.kind !== "confirmation-required") {
			return;
		}
		const crossGroup = await hub.invokeTool(
			"deleteAllTodos",
			{ confirm: first.confirmation.token },
			"hr",
		);
		expect(crossGroup.kind).toBe("confirmation-required");
		expect(await todoCount(hub, "hr")).toBe(before);
	});

	it("requests confirmation again when the confirm token is missing or malformed", async () => {
		const seed = uniqueTitle("no-token-seed");
		const { hub } = await policyHub({
			addTodo: { allowedGroups: ["manager"], requireConfirm: false },
			deleteAllTodos: { allowedGroups: ["manager"], requireConfirm: true },
			listTodos: { allowedGroups: ["manager"], requireConfirm: false },
		});
		const seeded = await hub.invokeTool("addTodo", { title: seed }, "manager");
		expect(seeded.kind).toBe("executed");
		const before = await todoCount(hub, "manager");

		const missing = await hub.invokeTool("deleteAllTodos", {}, "manager");
		expect(missing.kind).toBe("confirmation-required");
		const malformed = await hub.invokeTool("deleteAllTodos", { confirm: 123 }, "manager");
		expect(malformed.kind).toBe("confirmation-required");
		if (missing.kind === "confirmation-required" && malformed.kind === "confirmation-required") {
			expect(malformed.confirmation.token).not.toBe(missing.confirmation.token);
		}
		expect(await todoCount(hub, "manager")).toBe(before);
	});
});

describe("tool-usage reporting and audit", () => {
	it("reports denied, executed, and pending outcomes to the toolUsage hook", async () => {
		const title = uniqueTitle("usage-executed");
		const { hub, records } = await policyHub({
			addTodo: { allowedGroups: ["manager"], requireConfirm: false },
			deleteAllTodos: { allowedGroups: ["manager"], requireConfirm: true },
		});

		const denied = await hub.invokeTool("addTodo", { title }, "hr");
		expect(denied.kind).toBe("refused");
		const executed = await hub.invokeTool("addTodo", { title }, "manager");
		expect(executed.kind).toBe("executed");
		const pending = await hub.invokeTool("deleteAllTodos", {}, "manager");
		expect(pending.kind).toBe("confirmation-required");
		if (pending.kind !== "confirmation-required") {
			return;
		}
		const confirmed = await hub.invokeTool(
			"deleteAllTodos",
			{ confirm: pending.confirmation.token },
			"manager",
		);
		expect(confirmed.kind).toBe("executed");

		const deniedRecord = records.find((record) => record.groupId === "hr");
		expect(deniedRecord).toBeDefined();
		expect(deniedRecord?.confirmed).toBeUndefined();
		expect(deniedRecord?.controlId).toBe("tool-authorization");
		expect(deniedRecord?.groupId).toBe("hr");
		expect(deniedRecord?.requireConfirm).toBe(false);
		expect(deniedRecord?.toolName).toBe("addTodo");
		expect(deniedRecord?.verdict).toBe("block");

		const executedRecord = records.find(
			(record) => record.groupId === "manager" && record.toolName === "addTodo",
		);
		expect(executedRecord).toBeDefined();
		expect(executedRecord?.confirmed).toBeUndefined();
		expect(executedRecord?.groupId).toBe("manager");
		expect(executedRecord?.requireConfirm).toBe(false);
		expect(executedRecord?.toolName).toBe("addTodo");
		expect(executedRecord?.verdict).toBe("allow");

		const pendingRecord = records.find(
			(record) => record.confirmed === false && record.toolName === "deleteAllTodos",
		);
		expect(pendingRecord).toBeDefined();
		expect(pendingRecord?.confirmed).toBe(false);
		expect(pendingRecord?.controlId).toBe("tool-confirmation");
		expect(pendingRecord?.groupId).toBe("manager");
		expect(pendingRecord?.requireConfirm).toBe(true);
		expect(pendingRecord?.toolName).toBe("deleteAllTodos");
		expect(pendingRecord?.verdict).toBe("escalate");

		const confirmedRecord = records.find(
			(record) => record.confirmed === true && record.toolName === "deleteAllTodos",
		);
		expect(confirmedRecord).toBeDefined();
		expect(confirmedRecord?.confirmed).toBe(true);
		expect(confirmedRecord?.groupId).toBe("manager");
		expect(confirmedRecord?.requireConfirm).toBe(true);
		expect(confirmedRecord?.toolName).toBe("deleteAllTodos");
		expect(confirmedRecord?.verdict).toBe("allow");
	});

	it("audits confirmation requests as escalate with the tool name", async () => {
		const { audit, hub } = await policyHub({
			deleteAllTodos: { allowedGroups: ["manager"], requireConfirm: true },
		});

		const first = await hub.invokeTool("deleteAllTodos", {}, "manager");
		expect(first.kind).toBe("confirmation-required");

		const event = audit.events.find((entry) => entry.controlId === "tool-confirmation");
		expect(event).toBeDefined();
		expect(event?.groupId).toBe("manager");
		expect(event?.toolName).toBe("deleteAllTodos");
		expect(event?.verdict).toBe("escalate");
	});
});
