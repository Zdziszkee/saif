/**
 * Product wiring for the MCP safety hub: builds the hub once from environment
 * configuration. The hub is the tools-only plane (design D10): it assembles no
 * model connection, and AI prompt traffic is handled by the prompt-plane
 * gateway. The control pipeline runs the stages enabled by the default policy
 * profile in cheap-first order — allowlist, signature feed, deterministic
 * (bound live to the policy loader's active snapshot, so detection reloads
 * reach enforcement without a restart), semantic last. The semantic stage
 * additionally requires TYPESAFE_API_KEY: without it the tier is skipped
 * (and the skip audited) instead of failing every request closed.
 */

import { createAllowlistControl } from "#/control/allowlist.ts";
import {
	type AuditEvent,
	type AuditSink,
	auditEvent,
	createInMemoryAuditSink,
} from "#/control/audit.ts";
import { createFileAuditSink } from "#/control/audit-file.ts";
import { createControlPipeline } from "#/control/pipeline.ts";
import { createLiveDetectionControl } from "#/control/policy/live-control.ts";
import { FilePolicySource, PolicyLoader } from "#/control/policy/loader.ts";
import type { Policy } from "#/control/policy/schema.ts";
import { SEMANTIC_DEFAULTS } from "#/control/semantic/config.ts";
import { createSemanticControl } from "#/control/semantic/control.ts";
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

export interface HubStatus {
	feed: { ok: boolean; version: string };
	policy: { profile: string; version: string };
	semantic: { enabled: boolean; reason?: string | undefined };
}

let hubStatus: Omit<HubStatus, "feed"> | undefined;

const SEMANTIC_DISABLED_REASON =
	"semantic tier disabled: no usable TypeSafe API key (set TYPESAFE_API_KEY to enable JEV checks)";

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

/**
 * The semantic tier, or null when it cannot be configured (no TYPESAFE_API
 * key). An unconfigured tier is skipped — with the skip audited at build —
 * rather than installed as a control that fails every request closed.
 * Runtime failures of a configured tier still propagate and fail closed.
 *
 * Exported for the regression suite: it must keep returning null (not a
 * throwing control) when the key is absent.
 */
export function buildSemanticControl(): Control | null {
	const { checks, floors, maxChars, model, timeoutMs } = SEMANTIC_DEFAULTS;
	try {
		const classifier = createJevClassifier({ checks, floors, maxChars, model, timeoutMs });
		return createSemanticControl({ checks, classifier });
	} catch {
		return null;
	}
}

interface BuiltControls {
	consumers: ConsumerPolicy;
	controls: readonly Control[];
	failureVerdict: Verdict;
	knownGroups: readonly string[];
	policyProfile: string;
	policyVersion: string;
	semanticEnabled: boolean;
	semanticReason?: string | undefined;
}

interface StageAssembly {
	controls: Control[];
	semanticReason?: string | undefined;
	semanticSkipped: boolean;
}

/**
 * Cheap-first control stages for a loaded policy; detection stays bound to
 * the loader's active snapshot so reloads reach enforcement without a
 * restart, and the semantic stage is skipped when unusable.
 */
function assembleStages(policy: Policy, audit: AuditSink, loader: PolicyLoader): StageAssembly {
	const enabled = policy.profiles[policy.defaults.profile].enabledControls;
	const controls: Control[] = [createAllowlistControl(policy.controls.allowlist.models)];
	const assembly: StageAssembly = { controls, semanticSkipped: false };
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
		const semantic = buildSemanticControl();
		if (semantic === null) {
			assembly.semanticSkipped = true;
			assembly.semanticReason = SEMANTIC_DISABLED_REASON;
			audit.record(
				auditEvent("failure", {
					controlId: "semantic",
					detail: SEMANTIC_DISABLED_REASON,
				}),
			);
		} else {
			controls.push(semantic);
		}
	}
	return assembly;
}

async function buildControls(audit: AuditSink): Promise<BuiltControls> {
	const loader = new PolicyLoader(new FilePolicySource(POLICY_PATH));
	const status = await loader.start();
	if (!status.ok) {
		return {
			consumers: { defaultSubject: "default", knownKeys: [], unknownKey: "default-subject" },
			controls: [policyUnavailableControl()],
			failureVerdict: "block",
			knownGroups: [],
			policyProfile: "unavailable",
			policyVersion: "unavailable",
			semanticEnabled: false,
			semanticReason: "no valid policy loaded",
		};
	}
	const policy = status.snapshot.policy;
	const enabled = policy.profiles[policy.defaults.profile].enabledControls;
	const assembly = assembleStages(policy, audit, loader);
	return {
		consumers: consumerPolicyFromDocument(policy.consumers),
		controls: assembly.controls,
		failureVerdict: policy.defaults.failureVerdict,
		knownGroups: Object.keys(policy.groups),
		policyProfile: policy.defaults.profile,
		policyVersion: policy.version,
		semanticEnabled: enabled.semantic && !assembly.semanticSkipped,
		...(assembly.semanticReason === undefined ? {} : { semanticReason: assembly.semanticReason }),
	};
}

export function getHub(): Promise<Hub> {
	hubPromise ??= createHubAsync();
	return hubPromise;
}

async function createHubAsync(): Promise<Hub> {
	const {
		consumers,
		controls,
		failureVerdict,
		knownGroups,
		policyProfile,
		policyVersion,
		semanticEnabled,
		semanticReason,
	} = await buildControls(getAuditSink());
	hubStatus = {
		policy: { profile: policyProfile, version: policyVersion },
		semantic:
			semanticReason === undefined
				? { enabled: semanticEnabled }
				: { enabled: semanticEnabled, reason: semanticReason },
	};
	return createHub({
		audit: getAuditSink(),
		config: createHubConfig({
			consumers,
			egressAllowlist: parseAllowlist(env.MCP_EGRESS_ALLOWLIST),
			identity: { knownGroups: [...knownGroups] },
		}),
		pipeline: createControlPipeline({ controls, failureVerdict }),
	});
}

/**
 * Tier status for the UI: which defenses are actually live. The feed snapshot
 * is read fresh (hot reloads apply); policy and semantic state are captured
 * at hub build. No user content is included, so pages may call it keyless.
 */
export async function getHubStatus(): Promise<HubStatus> {
	await getHub();
	const feed = getSignatureFeedStore().snapshot();
	const built = hubStatus ?? {
		policy: { profile: "unavailable", version: "unavailable" },
		semantic: { enabled: false },
	};
	return {
		feed: { ok: feed.ok, version: feed.feed.version },
		policy: built.policy,
		semantic: built.semantic,
	};
}

export function getAuditSink(): AuditSink {
	auditSink ??= createProductAuditSink();
	return auditSink;
}

/**
 * Product sink: in-memory for the dashboard plus a durable JSONL file
 * (`tail -f data/audit.jsonl` shows every decision live). The in-memory
 * `events` array stays exposed — `readAuditEvents()` duck-types it, and a
 * fan-out object without it would read back empty. A broken log file
 * degrades to memory-only rather than taking down the hub.
 */
function createProductAuditSink(): AuditSink & { events: AuditEvent[] } {
	const memory = createInMemoryAuditSink();
	try {
		const file = createFileAuditSink("data/audit.jsonl");
		return {
			events: memory.events,
			record: (event) => {
				memory.record(event);
				file.record(event);
			},
		};
	} catch {
		return memory;
	}
}

function parseAllowlist(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}
