/**
 * Product wiring for the MCP safety hub: builds the hub once from environment
 * configuration. The hub is the tools-only plane (design D10): it assembles no
 * model connection, and AI prompt traffic is handled by the prompt-plane
 * gateway. The control pipeline runs the stages enabled by the default policy
 * profile in cheap-first order — allowlist, signature feed, deterministic
 * (bound live to the policy loader's active snapshot, so detection reloads
 * reach enforcement without a restart), semantic last.
 */

import { createAllowlistControl } from "#/control/allowlist.ts";
import { type AuditSink, createInMemoryAuditSink } from "#/control/audit.ts";
import { createControlPipeline } from "#/control/pipeline.ts";
import { createLiveDetectionControl } from "#/control/policy/live-control.ts";
import { FilePolicySource, PolicyLoader } from "#/control/policy/loader.ts";
import { SEMANTIC_DEFAULTS } from "#/control/semantic/config.ts";
import { createSemanticControl } from "#/control/semantic/control.ts";
import { SemanticConfigurationError } from "#/control/semantic/errors.ts";
import { createJevClassifier } from "#/control/semantic/jev.ts";
import { createSignatureControl } from "#/control/signatures/control.ts";
import { createSignatureFeedStore, type SignatureFeedStore } from "#/control/signatures/feed.ts";
import { type ConsumerPolicy, consumerPolicyFromDocument } from "#/control/subjects.ts";
import type { Control, Verdict } from "#/control/types.ts";
import { env } from "#/env.ts";
import { createHubConfig } from "./config.ts";
import { createHub, type Hub } from "./mcp-server.ts";

let auditSink: AuditSink | undefined;
let hubPromise: Promise<Hub> | undefined;

const POLICY_PATH = "policy.json";
const SIGNATURES_PATH = "signatures.json";

let signatureFeedStore: SignatureFeedStore | undefined;

/**
 * Built on first hub construction, not at module import: creating the store
 * watches the feed file, which must not run as an import side effect (it
 * crashed every importer when signatures.json was absent, including routes
 * that never touch signatures). The store lives for the process lifetime
 * after that, alongside the hub singleton.
 */
function getSignatureFeedStore(): SignatureFeedStore {
	signatureFeedStore ??= createSignatureFeedStore(SIGNATURES_PATH);
	return signatureFeedStore;
}

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

function semanticUnavailableControl(reason: string): Control {
	return {
		id: "semantic",
		inspect: () => {
			throw new SemanticConfigurationError(reason);
		},
	};
}

function buildSemanticControl(): Control {
	const { checks, floors, maxChars, model, timeoutMs } = SEMANTIC_DEFAULTS;
	try {
		const classifier = createJevClassifier({ checks, floors, maxChars, model, timeoutMs });
		return createSemanticControl({ checks, classifier });
	} catch {
		return semanticUnavailableControl(
			"semantic: no TypeSafe API key. Set TYPESAFE_API_KEY to enable the semantic tier.",
		);
	}
}

async function buildControls(): Promise<{
	consumers: ConsumerPolicy;
	controls: readonly Control[];
	failureVerdict: Verdict;
}> {
	const loader = new PolicyLoader(new FilePolicySource(POLICY_PATH));
	const status = await loader.start();
	if (!status.ok) {
		return {
			consumers: consumerPolicyFromDocument({}),
			controls: [policyUnavailableControl()],
			failureVerdict: "block",
		};
	}
	const policy = status.snapshot.policy;
	const enabled = policy.profiles[policy.defaults.profile].enabledControls;
	const controls: Control[] = [createAllowlistControl(policy.controls.allowlist.models)];
	if (enabled.signatures) {
		controls.push(
			createSignatureControl({
				config: policy.controls.signatures,
				getFeed: () => {
					const snapshot = getSignatureFeedStore().snapshot();
					if (!snapshot.ok) {
						throw new Error(`signature feed unavailable: ${snapshot.errors[0]?.message}`);
					}
					return snapshot.feed;
				},
			}),
		);
	}
	if (enabled.detection) {
		controls.push(
			createLiveDetectionControl(() => {
				const snapshot = loader.snapshot;
				return snapshot === undefined
					? undefined
					: {
							config: snapshot.policy.controls.detection,
							policyVersion: snapshot.policyVersion,
						};
			}),
		);
	}
	if (enabled.semantic) {
		controls.push(buildSemanticControl());
	}
	return {
		// The policy's consumer table is the known-key set: each key governs
		// as its own subject. Unknown keys keep the previous default-subject
		// behavior, so this only narrows, never widens, access.
		consumers: consumerPolicyFromDocument(policy.consumers),
		controls,
		failureVerdict: policy.defaults.failureVerdict,
	};
}

export function getHub(): Promise<Hub> {
	hubPromise ??= createHubAsync();
	return hubPromise;
}

async function createHubAsync(): Promise<Hub> {
	const { consumers, controls, failureVerdict } = await buildControls();
	return createHub({
		audit: getAuditSink(),
		config: createHubConfig({
			consumers,
			egressAllowlist: parseAllowlist(env.MCP_EGRESS_ALLOWLIST),
		}),
		pipeline: createControlPipeline({ controls, failureVerdict }),
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
