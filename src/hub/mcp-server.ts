/**
 * The MCP safety hub (interaction-gateway/mcp-safety-hub capability).
 *
 * The hub is the single governed path to models and tools: prompts reach the
 * model only through the `askModel` tool, every tool call executes through the
 * hub tool catalog under tool-call governance, and the standard MCP server
 * surface (`createMCPServer` from `@tanstack/ai-mcp/server`) serves the same
 * catalog the governed agentic loop uses, so the two cannot drift.
 */

import { toolDefinition } from "@tanstack/ai";
import { createMCPServer, type MCPServer } from "@tanstack/ai-mcp/server";
import { type AuditSink, auditEvent, noopAuditSink } from "#/control/audit.ts";
import { type ConsumerResolver, createConsumerResolver } from "#/control/subjects.ts";
import type { ControlPipeline } from "#/control/types.ts";
import {
	type CatalogEntry,
	createToolCatalog,
	type ToolCatalog,
	type ToolRegistration,
} from "./catalog.ts";
import { createHubConfig, type HubConfig } from "./config.ts";
import {
	type ConnectionOutcome,
	type ConnectRequest,
	createHubConnections,
	type HubConnections,
} from "./connections.ts";
import {
	createToolGovernor,
	definedRejection,
	type ToolCallOutcome,
	type ToolGovernor,
	type ToolRejection,
} from "./governance.ts";
import { createGrantRegistry, type GrantRegistry } from "./grants.ts";
import { type GovernedLoopTool, type LoopResult, runGovernedLoop } from "./loop.ts";
import type { ModelConnection } from "./model.ts";
import {
	type AskModelResult,
	askModelDescription,
	askModelInputSchema,
	askModelName,
	basicBuiltinTools,
} from "./tools.ts";

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
	model: ModelConnection;
	pipeline: ControlPipeline;
}

export interface Hub {
	addConnection(request: ConnectRequest): Promise<ConnectionOutcome>;
	addConnections(requests: ConnectRequest[]): Promise<ConnectionOutcome[]>;
	audit: AuditSink;
	config: HubConfig;
	connections: HubConnections;
	consumers: ConsumerResolver;
	grant(subject: string, toolName: string): void;
	invokeTool(name: string, args: unknown, subject: string): Promise<ToolCallOutcome>;
	pipeline: ControlPipeline;
	server(subject?: string): MCPServer;
	toolNames(): string[];
}

interface HubContext {
	audit: AuditSink;
	catalog: ToolCatalog;
	config: HubConfig;
	governor: ToolGovernor;
	grants: GrantRegistry;
	model: ModelConnection;
}

export async function createHub(deps: HubDeps): Promise<Hub> {
	const audit = deps.audit ?? noopAuditSink;
	const config = deps.config ?? createHubConfig();
	const consumers = createConsumerResolver(config.consumers);
	const grants: GrantRegistry = createGrantRegistry();
	const catalog: ToolCatalog = createToolCatalog({ audit, pipeline: deps.pipeline });
	const governor: ToolGovernor = createToolGovernor({ audit, grants, pipeline: deps.pipeline });
	const context: HubContext = { audit, catalog, config, governor, grants, model: deps.model };

	await admitBuiltinTools(catalog, grants, context);

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
		consumers,
		grant: (subject, toolName) => {
			grants.grant(subject, toolName);
		},
		invokeTool: (name, args, subject) => invokeTool(context, { args, name, subject }),
		pipeline: deps.pipeline,
		server: (subject = "anonymous") => buildServer(catalog, governor, subject),
		toolNames: () => catalog.snapshot().map((entry) => entry.name),
	};
}

async function admitBuiltinTools(
	catalog: ToolCatalog,
	grants: GrantRegistry,
	context: HubContext,
): Promise<void> {
	const registrations: ToolRegistration[] = [
		...basicBuiltinTools.map((spec) => ({
			description: spec.description,
			grantedByDefault: true,
			implementation: spec.implementation,
			inputSchema: spec.inputSchema,
			name: spec.name,
			source: "builtin" as const,
		})),
		createAskModelRegistration(context),
	];
	for (const registration of registrations) {
		// biome-ignore lint/performance/noAwaitInLoops: admission runs per builtin, in order
		const admitted = await catalog.register(registration);
		if (admitted.ok) {
			grants.registerTool(registration.name, true);
		}
	}
}

function createAskModelRegistration(context: HubContext): ToolRegistration {
	return {
		description: askModelDescription,
		grantedByDefault: true,
		implementation: (args, subject) => runAskModel(context, args, subject),
		inputSchema: askModelInputSchema,
		name: askModelName,
		source: "builtin",
	};
}

async function runAskModel(
	context: HubContext,
	args: unknown,
	subject: string,
): Promise<AskModelResult> {
	const { prompt } = args as { prompt: string };
	const result = await runGovernedLoop(prompt, {
		budgets: context.config.loop,
		enforcement: context.config.toolEnforcement,
		model: context.model,
		tools: loopToolsFor(context, subject),
	});
	return toAskModelResult(result, subject, context.audit);
}

function loopToolsFor(context: HubContext, subject: string): GovernedLoopTool[] {
	return context.catalog
		.snapshot()
		.filter((entry) => entry.name !== askModelName)
		.map((entry) => loopToolFor(entry, context, subject));
}

function loopToolFor(entry: CatalogEntry, context: HubContext, subject: string): GovernedLoopTool {
	return {
		execute: (args) => context.governor.governToolCall(entry, args, subject),
		spec: {
			description: entry.description,
			inputSchema: entry.inputSchema,
			name: entry.name,
		},
	};
}

function toAskModelResult(result: LoopResult, subject: string, audit: AuditSink): AskModelResult {
	if (result.kind === "answer") {
		return { answer: result.answer, control: "", status: "ok", verdict: "allow" };
	}
	if (result.kind === "over-budget") {
		audit.record(
			auditEvent("budget", {
				detail: `agentic loop exceeded budget after ${result.rounds} model requests`,
				subject,
				verdict: result.verdict,
			}),
		);
		return { answer: "", control: "budget", status: "over-budget", verdict: result.verdict };
	}
	return {
		answer: "",
		control: result.rejection.control,
		status: rejectionStatus(result.rejection),
		verdict: result.rejection.verdict,
	};
}

const REJECTION_STATUS: Record<ToolRejection["kind"], "blocked" | "escalated" | "failed"> = {
	blocked: "blocked",
	denied: "blocked",
	escalated: "escalated",
	failed: "failed",
};

function rejectionStatus(rejection: ToolRejection): "blocked" | "escalated" | "failed" {
	return REJECTION_STATUS[rejection.kind];
}

function buildServer(catalog: ToolCatalog, governor: ToolGovernor, subject: string): MCPServer {
	const tools = catalog.snapshot().map((entry) =>
		toolDefinition({
			description: entry.description,
			inputSchema: entry.inputSchema,
			name: entry.name,
		}).server(async (args) => {
			const outcome = await governor.governToolCall(entry, args, subject);
			if (outcome.kind === "refused") {
				throw new ToolGovernanceError(definedRejection(outcome.rejection));
			}
			return outcome.result;
		}),
	);
	return createMCPServer({ name: HUB_NAME, tools, version: HUB_VERSION });
}

function invokeTool(
	context: HubContext,
	call: { args: unknown; name: string; subject: string },
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
				controlId: rejection.control,
				detail: `unknown tool: ${call.name}`,
				seam: "mcp-tool",
				subject: call.subject,
				verdict: "block",
			}),
		);
		return Promise.resolve({ kind: "refused", rejection });
	}
	return context.governor.governToolCall(entry, call.args, call.subject);
}
