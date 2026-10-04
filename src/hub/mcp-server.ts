/**
 * The MCP safety hub (interaction-gateway/mcp-safety-hub capability).
 *
 * The hub is the governed tool plane (design D10): every tool call executes
 * through the hub tool catalog under tool-call governance, and the standard
 * MCP server surface (`createMCPServer` from `@tanstack/ai-mcp/server`) serves
 * the same catalog, so the served surface and direct invocations cannot drift.
 * The catalog is tools-only — model access is never exposed as an MCP tool;
 * AI prompt traffic belongs to the prompt-plane gateway.
 */

import { toolDefinition } from "@tanstack/ai";
import { createMCPServer, type MCPServer } from "@tanstack/ai-mcp/server";
import { type AuditSink, auditEvent, noopAuditSink } from "#/control/audit.ts";
import { createIdentityResolver, type IdentityResolver } from "#/control/subjects.ts";
import type { ControlPipeline } from "#/control/types.ts";
import { createToolCatalog, type ToolCatalog, type ToolRegistration } from "./catalog.ts";
import { createHubConfig, type HubConfig } from "./config.ts";
import {
	type ConnectionOutcome,
	type ConnectRequest,
	createHubConnections,
	type HubConnections,
} from "./connections.ts";
import {
	createToolGovernor,
	definedConfirmation,
	definedRejection,
	type ToolCallOutcome,
	type ToolGovernor,
	type ToolRejection,
	type ToolUsageSink,
} from "./governance.ts";
import { createGrantRegistry, type GrantRegistry } from "./grants.ts";
import type { ToolAccessPolicy } from "./tool-policy.ts";
import { basicBuiltinTools } from "./tools.ts";

export const HUB_NAME = "saif-control-hub";
export const HUB_VERSION = "0.1.0";

/** Raised in place of tool output when tool-call governance refuses a call. */
export class ToolGovernanceError extends Error {
	override readonly name = "ToolGovernanceError";
}

export interface HubDeps {
	audit?: AuditSink | undefined;
	config?: HubConfig | undefined;
	/** Transport fetch override for external MCP connections (tests substitute in-process servers). */
	fetch?: typeof fetch | undefined;
	pipeline: ControlPipeline;
	/** Declarative group→tool mapping from `policy.mcp.json`; manual grants win over it. */
	toolAccess?: ToolAccessPolicy | undefined;
	/** Durable-usage hook receiving every terminal tool-call outcome. */
	toolUsage?: ToolUsageSink | undefined;
}

export interface Hub {
	addConnection(request: ConnectRequest): Promise<ConnectionOutcome>;
	addConnections(requests: ConnectRequest[]): Promise<ConnectionOutcome[]>;
	audit: AuditSink;
	config: HubConfig;
	connections: HubConnections;
	grant(groupId: string, toolName: string): void;
	identity: IdentityResolver;
	invokeTool(
		name: string,
		args: unknown,
		groupId: string,
		consumerKey?: string,
	): Promise<ToolCallOutcome>;
	pipeline: ControlPipeline;
	server(groupId?: string, consumerKey?: string): MCPServer;
	toolNames(): string[];
}

interface HubContext {
	audit: AuditSink;
	catalog: ToolCatalog;
	config: HubConfig;
	governor: ToolGovernor;
	grants: GrantRegistry;
}

export async function createHub(deps: HubDeps): Promise<Hub> {
	const audit = deps.audit ?? noopAuditSink;
	const config = deps.config ?? createHubConfig();
	const identity = createIdentityResolver({ knownGroups: config.identity.knownGroups });
	const grants: GrantRegistry = createGrantRegistry({ access: deps.toolAccess });
	const catalog: ToolCatalog = createToolCatalog({ audit, pipeline: deps.pipeline });
	const governor: ToolGovernor = createToolGovernor({
		access: deps.toolAccess,
		audit,
		grants,
		pipeline: deps.pipeline,
		...(deps.toolUsage === undefined ? {} : { usage: deps.toolUsage }),
	});
	const context: HubContext = { audit, catalog, config, governor, grants };

	await admitBuiltinTools(catalog, grants);

	const connections: HubConnections = createHubConnections({
		audit,
		config,
		fetch: deps.fetch,
		grants,
		registerTool: catalog.register,
	});

	return {
		addConnection: (request) => connections.connect(request),
		addConnections: (requests) => connections.connectAll(requests),
		audit,
		config,
		connections,
		grant: (groupId, toolName) => {
			grants.grant(groupId, toolName);
		},
		identity,
		invokeTool: (name, args, groupId, consumerKey) =>
			invokeTool(context, { args, consumerKey, groupId, name }),
		pipeline: deps.pipeline,
		server: (groupId = "anonymous", consumerKey = "(none)") =>
			buildServer(catalog, governor, groupId, consumerKey),
		toolNames: () => catalog.snapshot().map((entry) => entry.name),
	};
}

async function admitBuiltinTools(catalog: ToolCatalog, grants: GrantRegistry): Promise<void> {
	const registrations: ToolRegistration[] = basicBuiltinTools.map((spec) => ({
		description: spec.description,
		grantedByDefault: true,
		implementation: spec.implementation,
		inputSchema: spec.inputSchema,
		name: spec.name,
		source: "builtin" as const,
	}));
	for (const registration of registrations) {
		// biome-ignore lint/performance/noAwaitInLoops: admission runs per builtin, in order
		const admitted = await catalog.register(registration);
		if (admitted.ok) {
			grants.registerTool(registration.name, true);
		}
	}
}

function buildServer(
	catalog: ToolCatalog,
	governor: ToolGovernor,
	groupId: string,
	consumerKey: string,
): MCPServer {
	const tools = catalog.snapshot().map((entry) =>
		toolDefinition({
			description: entry.description,
			inputSchema: entry.inputSchema,
			name: entry.name,
		}).server(async (args) => {
			const outcome = await governor.governToolCall(entry, args, groupId, consumerKey);
			if (outcome.kind === "refused") {
				throw new ToolGovernanceError(definedRejection(outcome.rejection));
			}
			if (outcome.kind === "confirmation-required") {
				throw new ToolGovernanceError(definedConfirmation(outcome.confirmation));
			}
			return outcome.result;
		}),
	);
	return createMCPServer({ name: HUB_NAME, tools, version: HUB_VERSION });
}

function invokeTool(
	context: HubContext,
	call: {
		args: unknown;
		consumerKey?: string | undefined;
		groupId: string;
		name: string;
	},
): Promise<ToolCallOutcome> {
	const entry = context.catalog.get(call.name);
	if (!entry) {
		const rejection: ToolRejection = {
			control: "tool-catalog",
			kind: "blocked",
			verdict: "block",
		};
		context.audit.record(
			auditEvent("interaction", {
				consumerKey: call.consumerKey ?? "(none)",
				controlId: rejection.control,
				detail: `unknown tool: ${call.name}`,
				groupId: call.groupId,
				seam: "mcp-tool",
				verdict: "block",
			}),
		);
		return Promise.resolve({ kind: "refused", rejection });
	}
	return context.governor.governToolCall(entry, call.args, call.groupId, call.consumerKey);
}
