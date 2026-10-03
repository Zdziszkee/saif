/**
 * Hub tool catalog with registration-time admission.
 *
 * Every tool — hub-hosted or registered from a connected MCP server — is
 * admitted through the control pipeline first: a tool schema or description
 * that matches a blocking control (e.g. a poisoned tool description) is
 * refused at registration, before any call, and the attempt is audited.
 */

import { z } from "zod";
import { type AuditSink, auditEvent, noopAuditSink } from "#/control/audit.ts";
import { type GuardRejection, guardInteraction } from "#/control/guard.ts";
import type { ControlPipeline } from "#/control/types.ts";

export type ToolSource = "builtin" | "connected";

export interface ToolRegistration {
	description: string;
	grantedByDefault: boolean;
	implementation: ToolImplementation;
	/** Zod schema or plain JSON schema; converted to JSON schema at registration. */
	inputSchema: unknown;
	name: string;
	source: ToolSource;
}

export type AdmissionResult = { ok: true } | { ok: false; rejection: GuardRejection };

export type ToolImplementation = (args: unknown, subject: string) => Promise<unknown> | unknown;

export interface CatalogEntry {
	description: string;
	grantedByDefault: boolean;
	implementation: ToolImplementation;
	/** JSON-schema form of the tool input schema. */
	inputSchema: Record<string, unknown>;
	name: string;
	source: ToolSource;
}

export interface ToolCatalog {
	get(name: string): CatalogEntry | undefined;
	register(request: ToolRegistration): Promise<AdmissionResult>;
	remove(name: string): void;
	snapshot(): CatalogEntry[];
}

export interface CatalogOptions {
	audit?: AuditSink | undefined;
	pipeline: ControlPipeline;
}

/** Serialized form of a tool schema inspected at registration. */
export function toolSchemaText(request: ToolRegistration, inputSchema: unknown): string {
	return JSON.stringify({
		description: request.description,
		inputSchema,
		name: request.name,
		source: request.source,
	});
}

/** Normalize a zod or plain-JSON schema to a JSON-schema object. */
export function toJsonSchema(schema: unknown): Record<string, unknown> {
	if (schema instanceof z.ZodType) {
		return z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
	}
	if (schema !== null && typeof schema === "object") {
		return schema as Record<string, unknown>;
	}
	return {};
}

export function createToolCatalog(options: CatalogOptions): ToolCatalog {
	const audit = options.audit ?? noopAuditSink;
	const entries = new Map<string, CatalogEntry>();

	return {
		get(name) {
			return entries.get(name);
		},
		async register(request) {
			const inputSchema = toJsonSchema(request.inputSchema);
			const outcome = await guardInteraction(
				{
					content: toolSchemaText(request, inputSchema),
					direction: "inbound",
					id: `reg_${request.name}`,
					seam: "mcp-tool",
					subject: "registry",
					tool: { arguments: inputSchema, name: request.name },
				},
				options.pipeline,
			);
			const refused = outcome.verdict === "block" || outcome.verdict === "escalate";
			audit.record(
				auditEvent("registration", {
					controlId: outcome.rejection?.control,
					detail: refused ? `tool refused at registration: ${request.name}` : request.name,
					subject: "registry",
					verdict: outcome.verdict,
				}),
			);
			if (refused) {
				return {
					ok: false,
					rejection: outcome.rejection ?? {
						control: "pipeline",
						status: 403,
						verdict: outcome.verdict,
					},
				};
			}
			entries.set(request.name, {
				description: request.description,
				grantedByDefault: request.grantedByDefault,
				implementation: request.implementation,
				inputSchema,
				name: request.name,
				source: request.source,
			});
			return { ok: true };
		},
		remove(name) {
			entries.delete(name);
		},
		snapshot() {
			return [...entries.values()];
		},
	};
}
