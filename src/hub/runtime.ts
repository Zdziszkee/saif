/**
 * Product wiring for the MCP safety hub: builds the hub once from environment
 * configuration. The model connection is the OpenAI-compatible connection from
 * env; when it is not configured, `askModel` fails with a clear configuration
 * error instead of the app failing to start. The control pipeline currently
 * runs in observe-only mode (no stages enabled) until the deterministic,
 * signature, semantic, and policy spec modules plug their controls in.
 */

import { type AuditSink, createInMemoryAuditSink } from "#/control/audit.ts";
import { createControlPipeline } from "#/control/pipeline.ts";
import { env } from "#/env.ts";
import { createHubConfig } from "./config.ts";
import { createHub, type Hub } from "./mcp-server.ts";
import {
	createOpenAICompatibleConnection,
	ModelConfigurationError,
	type ModelConnection,
} from "./model.ts";

let auditSink: AuditSink | undefined;
let hubPromise: Promise<Hub> | undefined;

export function getHub(): Promise<Hub> {
	hubPromise ??= createHub({
		audit: getAuditSink(),
		config: createHubConfig({ egressAllowlist: parseAllowlist(env.MCP_EGRESS_ALLOWLIST) }),
		model: modelConnectionFromEnv(),
		pipeline: createControlPipeline({ controls: [] }),
	});
	return hubPromise;
}

export function getAuditSink(): AuditSink {
	auditSink ??= createInMemoryAuditSink();
	return auditSink;
}

function modelConnectionFromEnv(): ModelConnection {
	try {
		return createOpenAICompatibleConnection({
			apiKey: env.MODEL_API_KEY,
			baseUrl: env.MODEL_BASE_URL,
			modelName: env.MODEL_NAME,
		});
	} catch (error) {
		if (error instanceof ModelConfigurationError) {
			return {
				complete: () => {
					throw error;
				},
				modelName: "unconfigured",
			};
		}
		throw error;
	}
}

function parseAllowlist(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}
