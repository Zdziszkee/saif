/**
 * Human approval for restricted MCP tool calls (elicitation-first).
 *
 * Covers the pure pieces (message wording, elicitation-failure
 * classification, approval wait) plus the orchestration around the
 * governor: accept executes the stored pending call, decline/timeout
 * denies and audits, unsupported clients keep the legacy token protocol.
 * The live elicitation round trip itself is exercised manually against
 * OpenCode; here the client side is a stub.
 */

import { describe, expect, it } from "bun:test";
import { createMCPClient } from "@tanstack/ai-mcp";
import type { CatalogEntry } from "#/hub/catalog.ts";
import { createToolCatalog } from "#/hub/catalog.ts";
import {
	approvalMessage,
	isUnsupportedElicitation,
	requestHumanApproval,
} from "#/hub/confirmation.ts";
import type { ToolGovernor } from "#/hub/governance.ts";
import { definedConfirmation } from "#/hub/governance.ts";
import { createHub, executeWithHumanApproval } from "#/hub/mcp-server.ts";
import { createToolPolicyRegistry } from "#/hub/tool-policy.ts";
import { hubFetchShim } from "./helpers/external-server.ts";
import { auditSink, pipelineWith } from "./helpers/fixtures.ts";

const TOOL_NAME = "deleteAllTodos";
const GROUP_ID = "manager";
const CONSUMER_KEY = "carol";
const PENDING_TOKEN = "pending-token-1";

function stubEntry(): CatalogEntry {
	return {
		description: "Remove every todo.",
		grantedByDefault: true,
		implementation: () => ({ removed: 0 }),
		inputSchema: {},
		name: TOOL_NAME,
		source: "builtin",
	};
}

function stubGovernor(
	behavior: (args: unknown) => { kind: "executed" } | { kind: "refused" },
	seen: unknown[],
): ToolGovernor {
	return {
		governToolCall: (entry, args, groupId, consumerKey) => {
			seen.push({ args, consumerKey, groupId, tool: entry.name });
			if (behavior(args).kind === "refused") {
				return Promise.resolve({
					kind: "refused",
					rejection: { control: "test", kind: "blocked", verdict: "block" },
				});
			}
			return Promise.resolve({ kind: "executed", result: { ok: true }, resultVerdict: "allow" });
		},
	} as ToolGovernor;
}

describe("approvalMessage", () => {
	it("names the tool and group and bounds approval to one call", () => {
		const message = approvalMessage(TOOL_NAME, GROUP_ID);
		expect(message).toContain(TOOL_NAME);
		expect(message).toContain(GROUP_ID);
		expect(message).toContain("once");
		expect(message).not.toContain(PENDING_TOKEN);
	});
});

describe("isUnsupportedElicitation", () => {
	it("flags method-not-found, capability gates, and sessionless transports", () => {
		expect(isUnsupportedElicitation({ code: -32_601 })).toBe(true);
		expect(isUnsupportedElicitation({ code: "CAPABILITY_NOT_SUPPORTED" })).toBe(true);
		expect(
			isUnsupportedElicitation(new Error("ctx.context.requestInput needs a spec 2025 session")),
		).toBe(true);
	});

	it("treats declines, cancels, and junk as denials, not fallback", () => {
		expect(isUnsupportedElicitation(new Error("The user did not accept the input request."))).toBe(
			false,
		);
		expect(isUnsupportedElicitation(new Error("boom"))).toBe(false);
		expect(isUnsupportedElicitation(null)).toBe(false);
		expect(isUnsupportedElicitation("nope")).toBe(false);
		expect(isUnsupportedElicitation({})).toBe(false);
	});
});

describe("requestHumanApproval", () => {
	it("reports unsupported without a prompt callback", async () => {
		await expect(requestHumanApproval({ message: "hi" })).resolves.toEqual({
			decision: "unsupported",
		});
	});

	it("approves on any accepted answer", async () => {
		await expect(
			requestHumanApproval({ message: "hi", requestApproval: () => Promise.resolve("yes") }),
		).resolves.toEqual({ decision: "approved" });
	});

	it("denies declines and transport failures", async () => {
		await expect(
			requestHumanApproval({
				message: "hi",
				requestApproval: () =>
					Promise.reject(new Error("The user did not accept the input request.")),
			}),
		).resolves.toEqual({ decision: "denied", reason: "rejected" });
	});

	it("denies (timed-out) instead of hanging forever", async () => {
		await expect(
			requestHumanApproval({
				message: "hi",
				requestApproval: () =>
					new Promise<unknown>(() => {
						// Never resolves: the timeout must fire instead.
					}),
				timeoutMs: 20,
			}),
		).resolves.toEqual({ decision: "denied", reason: "timed-out" });
	});

	it("rethrows era-2026 round-trip demands instead of deciding", async () => {
		const { ToolInputRequiredError } = await import("@tanstack/ai-mcp/server");
		const demand = new ToolInputRequiredError({ message: "approve?" });
		await expect(
			requestHumanApproval({
				message: "hi",
				requestApproval: () => Promise.reject(demand),
			}),
		).rejects.toBe(demand);
	});
});

describe("executeWithHumanApproval", () => {
	it("executes the stored call on accept, passing the pending token", async () => {
		const audit = auditSink();
		const seen: unknown[] = [];
		const governor = stubGovernor(() => ({ kind: "executed" }), seen);
		const result = await executeWithHumanApproval({
			audit,
			confirmation: { token: PENDING_TOKEN, tool: TOOL_NAME },
			consumerKey: CONSUMER_KEY,
			entry: stubEntry(),
			governor,
			groupId: GROUP_ID,
			requestApproval: () => Promise.resolve("approved"),
		});
		expect(result).toEqual({ ok: true });
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			args: { confirm: PENDING_TOKEN },
			consumerKey: CONSUMER_KEY,
			groupId: GROUP_ID,
			tool: TOOL_NAME,
		});
	});

	it("keeps the legacy token error when elicitation is unsupported", async () => {
		const audit = auditSink();
		const governor = stubGovernor(() => ({ kind: "executed" }), []);
		const error = await executeWithHumanApproval({
			audit,
			confirmation: { token: PENDING_TOKEN, tool: TOOL_NAME },
			consumerKey: CONSUMER_KEY,
			entry: stubEntry(),
			governor,
			groupId: GROUP_ID,
			requestApproval: undefined,
		}).then(
			() => null,
			(failure: unknown) => failure,
		);
		expect(String((error as Error).message)).toBe(
			definedConfirmation({ token: PENDING_TOKEN, tool: TOOL_NAME }),
		);
		expect(audit.events).toHaveLength(0);
	});

	it("denies and audits a declined approval without leaking a token", async () => {
		const audit = auditSink();
		const governor = stubGovernor(() => ({ kind: "executed" }), []);
		const error = await executeWithHumanApproval({
			audit,
			confirmation: { token: PENDING_TOKEN, tool: TOOL_NAME },
			consumerKey: CONSUMER_KEY,
			entry: stubEntry(),
			governor,
			groupId: GROUP_ID,
			requestApproval: () => Promise.reject(new Error("declined")),
		}).then(
			() => null,
			(failure: unknown) => failure,
		);
		const payload = JSON.parse(String((error as Error).message)) as Record<string, unknown>;
		expect(payload).toMatchObject({ control: "tool-confirmation", verdict: "block" });
		expect(JSON.stringify(payload)).not.toContain(PENDING_TOKEN);
		expect(
			audit.events.some(
				(event) =>
					event.controlId === "tool-confirmation" &&
					event.verdict === "block" &&
					(event.detail ?? "").includes("declined"),
			),
		).toBe(true);
	});
});

describe("served MCP server instances", () => {
	it("reuses one server per group and user", async () => {
		const hub = await createHub({ audit: auditSink(), pipeline: pipelineWith([]) });
		expect(hub.server("manager", "carol")).toBe(hub.server("manager", "carol"));
		expect(hub.server("manager", "dave")).not.toBe(hub.server("manager", "carol"));
		expect(hub.server("hr", "carol")).not.toBe(hub.server("manager", "carol"));
	});

	it("surfaces an elicitation demand (never a silent deny) over MCP", async () => {
		const audit = auditSink();
		const registry = createToolPolicyRegistry();
		registry.update({
			policy: {
				tools: { deleteAllTodos: { allowedGroups: ["manager"], requireConfirm: true } },
				version: "1",
			},
			version: "1",
		});
		const hub = await createHub({ audit, pipeline: pipelineWith([]), toolAccess: registry });
		const client = await createMCPClient({
			transport: {
				fetch: hubFetchShim((request) => hub.server("manager", "carol").fetch(request)),
				type: "http",
				url: "https://hub.test/mcp",
			},
		});
		const outcome = await client.callTool("deleteAllTodos", {}).then(
			() => null,
			(failure: unknown) => failure,
		);
		expect(outcome).not.toBeNull();
		const demand = outcome as { message?: unknown; request?: { message?: unknown } };
		expect(String(demand.message ?? "")).toContain("asked for input");
		expect(String(demand.request?.message ?? "")).toContain(TOOL_NAME);
		expect(String(demand.request?.message ?? "")).not.toContain(PENDING_TOKEN);
		await client.close();
	});
});

describe("tool catalog version", () => {
	it("bumps on register and remove only", async () => {
		const catalog = createToolCatalog({ pipeline: pipelineWith([]) });
		expect(catalog.version()).toBe(0);
		await catalog.register({
			description: "t",
			grantedByDefault: true,
			implementation: () => ({}),
			inputSchema: {},
			name: "tool-a",
			source: "builtin",
		});
		expect(catalog.version()).toBe(1);
		catalog.remove("missing");
		expect(catalog.version()).toBe(1);
		catalog.remove("tool-a");
		expect(catalog.version()).toBe(2);
	});
});
