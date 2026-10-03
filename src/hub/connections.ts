/**
 * External MCP server connections (MCP safety hub requirement).
 *
 * Users connect external MCP servers (Confluence, Jira, ...) with an endpoint
 * and a per-service credential. Connected tools register dynamically into the
 * hub tool catalog *ungranted* — calls are denied until the subject is granted
 * — and every call flows through the same tool-call governance as built-in
 * tools. Endpoints outside the policy's egress allowlist are rejected and the
 * attempt is audited.
 *
 * Credential custody: the service token is passed to the transport as a
 * per-connection header so it is used only to call its target server. It is
 * not retained in the connection record, the tool catalog, model-visible
 * content, logs, or audit records.
 */

import {
	createMCPClient,
	createMCPClients,
	type MCPClient,
	type MCPClientOptions,
	type McpServerTool,
	type TransportInput,
} from "@tanstack/ai-mcp";
import { type AuditSink, auditEvent, noopAuditSink } from "#/control/audit.ts";
import type { AdmissionResult, ToolImplementation, ToolRegistration } from "./catalog.ts";
import { type HubConfig, isEgressAllowed } from "./config.ts";
import type { GrantRegistry } from "./grants.ts";

export interface ConnectRequest {
	endpoint: string;
	name: string;
	subject: string;
	/** Per-service credential; forwarded only as a transport header to `endpoint`. */
	token?: string | undefined;
}

export interface ConnectionInfo {
	endpoint: string;
	name: string;
	tools: string[];
}

export type ConnectionOutcome =
	| { connection: ConnectionInfo; ok: true }
	| { error: string; ok: false };

export interface ConnectionsOptions {
	audit?: AuditSink | undefined;
	config: HubConfig;
	/** Transport fetch override (tests substitute in-process MCP servers). */
	fetch?: typeof fetch | undefined;
	grants: GrantRegistry;
	registerTool: (registration: ToolRegistration) => Promise<AdmissionResult>;
}

export interface HubConnections {
	connect(request: ConnectRequest): Promise<ConnectionOutcome>;
	connectAll(requests: ConnectRequest[]): Promise<ConnectionOutcome[]>;
	list(): ConnectionInfo[];
	remove(name: string): Promise<void>;
}

interface ConnectionRecord {
	closer: () => Promise<void>;
	info: ConnectionInfo;
}

interface ConnectionsState {
	audit: AuditSink;
	options: ConnectionsOptions;
	records: Map<string, ConnectionRecord>;
}

export function createHubConnections(options: ConnectionsOptions): HubConnections {
	const state: ConnectionsState = {
		audit: options.audit ?? noopAuditSink,
		options,
		records: new Map(),
	};

	return {
		connect: (request) => connectOne(state, request),
		connectAll: (requests) => connectMany(state, requests),
		list: () => [...state.records.values()].map((record) => record.info),
		remove: (name) => removeConnection(state, name),
	};
}

function reject(
	state: ConnectionsState,
	request: ConnectRequest,
	error: string,
): ConnectionOutcome {
	state.audit.record(
		auditEvent("connection", {
			detail: `connection rejected: ${request.name} (${request.endpoint}): ${error}`,
			subject: request.subject,
			verdict: "block",
		}),
	);
	return { error, ok: false };
}

async function registerConnectedTools(
	state: ConnectionsState,
	request: ConnectRequest,
	tools: readonly McpServerTool[],
	implementationFor: (tool: McpServerTool) => ToolImplementation,
): Promise<ConnectionInfo> {
	const registered: string[] = [];
	for (const tool of tools) {
		const registration: ToolRegistration = {
			description: tool.description ?? "",
			grantedByDefault: false,
			implementation: implementationFor(tool),
			inputSchema: tool.inputSchema ?? {},
			name: tool.name,
			source: "connected",
		};
		// biome-ignore lint/performance/noAwaitInLoops: admission runs per tool, in order
		const admitted = await state.options.registerTool(registration);
		if (admitted.ok) {
			state.options.grants.registerTool(tool.name, false);
			registered.push(tool.name);
		}
	}
	return { endpoint: request.endpoint, name: request.name, tools: registered };
}

function recordEstablished(
	state: ConnectionsState,
	request: ConnectRequest,
	closer: () => Promise<void>,
	info: ConnectionInfo,
): ConnectionOutcome {
	state.records.set(request.name, { closer, info });
	state.audit.record(
		auditEvent("connection", {
			detail: `connection established: ${request.name} (${info.tools.length} tools)`,
			subject: request.subject,
			verdict: "allow",
		}),
	);
	return { connection: info, ok: true };
}

async function connectOne(
	state: ConnectionsState,
	request: ConnectRequest,
): Promise<ConnectionOutcome> {
	if (!isEgressAllowed(request.endpoint, state.options.config.egressAllowlist)) {
		return reject(state, request, "endpoint outside the egress allowlist");
	}
	if (state.records.has(request.name)) {
		return reject(state, request, "connection name already in use");
	}

	const client: MCPClient = await createMCPClient({
		prefix: request.name,
		transport: transportFor(request, state.options.fetch),
	});
	try {
		const tools = await client.tools();
		const info = await registerConnectedTools(state, request, tools, (tool) => async (args) => {
			const result = await client.callTool(tool.metadata.mcp.serverToolName, args);
			return unwrapToolResult(result);
		});
		return recordEstablished(state, request, () => client.close(), info);
	} catch (error) {
		await client.close();
		return reject(state, request, error instanceof Error ? error.message : String(error));
	}
}

async function connectMany(
	state: ConnectionsState,
	requests: readonly ConnectRequest[],
): Promise<ConnectionOutcome[]> {
	const outcomes: ConnectionOutcome[] = [];
	const accepted = requests.filter((request) => {
		const allowed = isEgressAllowed(request.endpoint, state.options.config.egressAllowlist);
		if (!allowed) {
			outcomes.push(reject(state, request, "endpoint outside the egress allowlist"));
		}
		return allowed;
	});
	if (accepted.length === 0) {
		return outcomes;
	}

	const config: Record<string, MCPClientOptions> = Object.fromEntries(
		accepted.map((request) => [
			request.name,
			{ prefix: request.name, transport: transportFor(request, state.options.fetch) },
		]),
	);
	const pool = await createMCPClients(config);
	const tools = await pool.tools();
	for (const request of accepted) {
		const owned = tools.filter((tool) => tool.metadata.mcp.serverId === request.name);
		// biome-ignore lint/performance/noAwaitInLoops: admission runs per server, in order
		const info = await registerConnectedTools(state, request, owned, (tool) => async (args) => {
			const client = pool.clients[tool.metadata.mcp.serverId ?? request.name];
			if (!client) {
				throw new Error(`no client for connected server ${request.name}`);
			}
			const result = await client.callTool(tool.metadata.mcp.serverToolName, args);
			return unwrapToolResult(result);
		});
		outcomes.push(recordEstablished(state, request, () => pool.close(), info));
	}
	return outcomes;
}

async function removeConnection(state: ConnectionsState, name: string): Promise<void> {
	const record = state.records.get(name);
	if (!record) {
		return;
	}
	for (const toolName of record.info.tools) {
		state.options.grants.registerTool(toolName, false);
	}
	await record.closer();
	state.records.delete(name);
}

/** The service token travels only in this transport header, only to its server. */
function transportFor(request: ConnectRequest, fetchOverride?: typeof fetch): TransportInput {
	return {
		type: "http",
		url: request.endpoint,
		...(request.token ? { headers: { Authorization: `Bearer ${request.token}` } } : {}),
		...(fetchOverride ? { fetch: fetchOverride } : {}),
	};
}

/**
 * Unwrap a remote MCP tool result to its structured output, its single text
 * payload (JSON parsed when possible), or the list of text parts.
 */
function unwrapToolResult(rawResult: unknown): unknown {
	const result = rawResult as {
		content?: Array<{ text?: string | undefined }>;
		structuredContent?: unknown;
	};
	if (result.structuredContent !== undefined) {
		return result.structuredContent;
	}
	const texts = (result.content ?? [])
		.filter((part) => typeof part.text === "string")
		.map((part) => part.text ?? "");
	const single = texts.length === 1 ? texts[0] : undefined;
	if (single !== undefined) {
		try {
			return JSON.parse(single);
		} catch {
			return single;
		}
	}
	return texts;
}
