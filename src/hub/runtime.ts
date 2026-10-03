/**
 * Product wiring for the MCP safety hub: builds the hub once from environment
 * configuration. The hub is the tools-only plane (design D10): it assembles no
 * model connection, and AI prompt traffic is handled by the prompt-plane
 * gateway. The control pipeline runs the deterministic control set from the
 * loaded policy and fails closed when no valid policy exists.
 */

import { type AuditSink, createInMemoryAuditSink } from "#/control/audit.ts";
import { createDeterministicControl } from "#/control/deterministic/control.ts";
import { createControlPipeline } from "#/control/pipeline.ts";
import { FilePolicySource, PolicyLoader } from "#/control/policy/loader.ts";
import type { Control } from "#/control/types.ts";
import { env } from "#/env.ts";
import { createHubConfig } from "./config.ts";
import { createHub, type Hub } from "./mcp-server.ts";

let auditSink: AuditSink | undefined;
let hubPromise: Promise<Hub> | undefined;

const POLICY_PATH = "policy.json";

function policyUnavailableControl(): Control {
	return {
		id: "policy-unavailable",
		inspect: () => ({
			hit: {
				controlId: "policy-unavailable",
				detail: "no valid policy loaded",
				kind: "policy",
				verdict: "block",
			},
			verdict: "block",
		}),
	};
}

async function buildControls(): Promise<readonly Control[]> {
	const loader = new PolicyLoader(new FilePolicySource(POLICY_PATH));
	const status = await loader.start();
	if (!status.ok) {
		return [policyUnavailableControl()];
	}
	return [createDeterministicControl(status.snapshot.policy.controls.detection)];
}

export function getHub(): Promise<Hub> {
	hubPromise ??= createHubAsync();
	return hubPromise;
}

async function createHubAsync(): Promise<Hub> {
	return createHub({
		audit: getAuditSink(),
		config: createHubConfig({ egressAllowlist: parseAllowlist(env.MCP_EGRESS_ALLOWLIST) }),
		pipeline: createControlPipeline({ controls: await buildControls() }),
	});
}

export function getAuditSink(): AuditSink {
	auditSink ??= createInMemoryAuditSink();
	return auditSink;
}

function parseAllowlist(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}
