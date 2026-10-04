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
import {
	type CatalogEntry,
	createToolCatalog,
	type ToolCatalog,
	type ToolRegistration,
} from "./catalog.ts";
import { createHubConfig, type HubConfig } from "./config.ts";
import { approvalMessage, requestHumanApproval } from "./confirmation.ts";
import {
	type ConnectionOutcome,
	type ConnectRequest,
	createHubConnections,
	type HubConnections,
} from "./connections.ts";
import {
	type ConfirmationRequest,
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

interface CachedServer {
	catalogVersion: number;
	server: MCPServer;
}

/** Cap for served MCP server instances (one per group+user by default). */
const MAX_CACHED_SERVERS = 200;

interface HubContext {
	audit: AuditSink;
	catalog: ToolCatalog;
	config: HubConfig;
	governor: ToolGovernor;
	grants: GrantRegistry;
	servers: Map<string, CachedServer>;
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
	const context: HubContext = { audit, catalog, config, governor, grants, servers: new Map() };

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
			serverFor(context, groupId, consumerKey),
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

/**
 * Served MCP server instances, one per group+user. Instances are shared
 * across HTTP requests (unlike the previous per-request build) because
 * `sessions: "memory"` keeps elicitation-capable sessions in the instance:
 * a fresh server per request would drop every session immediately. Entries
 * rebuild when the tool catalog changes and the oldest spill past the cap.
 */
function serverFor(context: HubContext, groupId: string, consumerKey: string): MCPServer {
	const key = `${groupId}\n${consumerKey}`;
	const version = context.catalog.version();
	const cached = context.servers.get(key);
	if (cached !== undefined && cached.catalogVersion === version) {
		context.servers.delete(key);
		context.servers.set(key, cached);
		return cached.server;
	}
	const server = buildServer(context, groupId, consumerKey);
	context.servers.set(key, { catalogVersion: version, server });
	while (context.servers.size > MAX_CACHED_SERVERS) {
		const oldest = context.servers.keys().next();
		if (oldest.done === true) {
			break;
		}
		context.servers.delete(oldest.value);
	}
	return server;
}

/** Tool-handler approval hooks (subset of the MCP SDK tool context, which
 * the transport nests under `context`; every field optional so sessionless
 * transports degrade to the token protocol). */
interface ApprovalHooks {
	requestInput?: ((request: { message: string }) => Promise<unknown>) | undefined;
}

/**
 * Run a confirmation-gated call through human approval. Accept executes the
 * stored pending arguments (never fresh ones — approval cannot be
 * retargeted); decline/timeout denies and audits; unsupported clients keep
 * the legacy token protocol via `confirmation-required`.
 */
export async function executeWithHumanApproval(input: {
	audit: AuditSink;
	confirmation: ConfirmationRequest;
	consumerKey: string;
	entry: CatalogEntry;
	governor: ToolGovernor;
	groupId: string;
	requestApproval: ((message: string) => Promise<unknown>) | undefined;
}): Promise<unknown> {
	const approval = await requestHumanApproval({
		message: approvalMessage(input.confirmation.tool, input.groupId),
		requestApproval: input.requestApproval,
	});
	if (approval.decision === "unsupported") {
		throw new ToolGovernanceError(definedConfirmation(input.confirmation));
	}
	if (approval.decision === "denied") {
		input.audit.record(
			auditEvent("interaction", {
				consumerKey: input.consumerKey,
				controlId: "tool-confirmation",
				detail:
					approval.reason === "timed-out"
						? `human did not answer in time: ${input.confirmation.tool}`
						: `human declined: ${input.confirmation.tool}`,
				groupId: input.groupId,
				seam: "mcp-tool",
				toolName: input.confirmation.tool,
				verdict: "block",
			}),
		);
		throw new ToolGovernanceError(
			definedRejection({ control: "tool-confirmation", kind: "denied", verdict: "block" }),
		);
	}
	const confirmed = await input.governor.governToolCall(
		input.entry,
		{ confirm: input.confirmation.token },
		input.groupId,
		input.consumerKey,
	);
	if (confirmed.kind === "confirmation-required") {
		throw new ToolGovernanceError(definedConfirmation(confirmed.confirmation));
	}
	if (confirmed.kind === "refused") {
		throw new ToolGovernanceError(definedRejection(confirmed.rejection));
	}
	return confirmed.result;
}

function buildServer(context: HubContext, groupId: string, consumerKey: string): MCPServer {
	const { audit, catalog, governor } = context;
	const tools = catalog.snapshot().map((entry) =>
		toolDefinition({
			description: entry.description,
			inputSchema: entry.inputSchema,
			name: entry.name,
		}).server<ApprovalHooks>(async (args, ctx) => {
			const outcome = await governor.governToolCall(entry, args, groupId, consumerKey);
			if (outcome.kind === "refused") {
				throw new ToolGovernanceError(definedRejection(outcome.rejection));
			}
			if (outcome.kind === "confirmation-required") {
				const requestInput = ctx.context?.requestInput;
				return await executeWithHumanApproval({
					audit,
					confirmation: outcome.confirmation,
					consumerKey,
					entry,
					governor,
					groupId,
					requestApproval:
						typeof requestInput === "function"
							? (message: string): Promise<unknown> => requestInput({ message })
							: undefined,
				});
			}
			return outcome.result;
		}),
	);
	return createMCPServer({ name: HUB_NAME, sessions: "memory", tools, version: HUB_VERSION });
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
