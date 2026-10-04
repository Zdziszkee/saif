/**
 * Product wiring for the MCP safety hub: builds the hub once from environment
 * configuration. The hub is the tools-only plane (design D10): it assembles no
 * model connection, and AI prompt traffic is handled by the prompt-plane
 * gateway. The control pipeline runs the stages enabled by the default policy
 * profile in cheap-first order — allowlist, signature feed, deterministic
 * (bound live to the policy loader's active snapshot, so detection reloads
 * reach enforcement without a restart), semantic last. Only detection is
 * live-bound: every other policy surface (allowlist, signature config,
 * thresholds, profiles, identity, verdicts) is snapshotted at build and
 * takes effect via `refreshHubAfterPolicyWrite()`, which drops the cached
 * hub so the next request rebuilds from disk. In-flight requests keep their
 * hub reference and finish on the old pipeline. The semantic stage
 * additionally requires TYPESAFE_API_KEY: without it the tier is skipped
 * (and the skip audited) instead of failing every request closed.
 */

import { createAllowlistControl } from "#/control/allowlist.ts";
import {
	type AuditEvent,
	type AuditSink,
	auditEvent,
	createInMemoryAuditSink,
	isAuditDecision,
} from "#/control/audit.ts";
import { createFileAuditSink } from "#/control/audit-file.ts";
import { createControlPipeline } from "#/control/pipeline.ts";
import { type ResolvedProfile, resolveProfile } from "#/control/policy/apply.ts";
import { createLiveDetectionControl } from "#/control/policy/live-control.ts";
import { FilePolicySource, PolicyLoader } from "#/control/policy/loader.ts";
import type { Policy } from "#/control/policy/schema.ts";
import { policyUnavailableControl } from "#/control/policy/unavailable.ts";
import { SEMANTIC_DEFAULTS } from "#/control/semantic/config.ts";
import { createSemanticControl } from "#/control/semantic/control.ts";
import { createJevClassifier } from "#/control/semantic/jev.ts";
import { createSignatureControl } from "#/control/signatures/control.ts";
import { createSignatureFeedStore, type SignatureFeedStore } from "#/control/signatures/feed.ts";
import { type IdentityPolicy, identityPolicyFromDocument } from "#/control/subjects.ts";
import type { Control, Verdict } from "#/control/types.ts";
import { env } from "#/env.ts";
import type { GatewayDeps, UpstreamConfig } from "#/gateway/gateway.ts";
import { fetchPriceTable, type ModelPriceTable } from "#/gateway/prices.ts";
import { type BudgetRule, UsageLedger } from "#/gateway/usage.ts";
import { createHubConfig } from "./config.ts";
import { createHub, type Hub } from "./mcp-server.ts";
import {
	createFileToolPolicyStore,
	createToolPolicyRegistry,
	type ToolPolicyRegistry,
} from "./tool-policy.ts";
import { recordToolCall, type ToolUsageRecord } from "./tool-usage.ts";

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
let toolPolicyRegistry: ToolPolicyRegistry | undefined;

/** Shared tool access policy: content swaps on file reload, references stay stable. */
function getToolPolicyRegistry(): ToolPolicyRegistry {
	toolPolicyRegistry ??= createToolPolicyRegistry();
	return toolPolicyRegistry;
}

/**
 * Built on first hub construction, not at module import: creating the store
 * watches the feed file, which must not run as an import side effect (it
 * crashed every importer when signatures.json was absent, including routes
 * that never touch signatures). The store lives for the process lifetime
 * after that, alongside the hub singleton.
 */
export function getSignatureFeedStore(): SignatureFeedStore {
	signatureFeedStore ??= createSignatureFeedStore(SIGNATURES_PATH);
	return signatureFeedStore;
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
	// policy.jev.json loads once at import into SEMANTIC_DEFAULTS (see
	// `#/control/semantic/config.ts`); a UI policy refresh does not re-read
	// it — Jev config reload is out of scope for the policy hot path.
	const { checks, floors, maxChars, model, timeoutMs } = SEMANTIC_DEFAULTS;
	try {
		const classifier = createJevClassifier({
			...(env.TYPESAFE_API_KEY === undefined ? {} : { apiKey: env.TYPESAFE_API_KEY }),
			...(env.TYPESAFE_BASE_URL === undefined ? {} : { baseUrl: env.TYPESAFE_BASE_URL }),
			checks,
			floors,
			maxChars,
			model,
			timeoutMs,
		});
		return createSemanticControl({ checks, classifier });
	} catch {
		return null;
	}
}

interface BuiltControls {
	budgetRules: readonly BudgetRule[];
	budgetVerdict: Verdict;
	controls: readonly Control[];
	failureVerdict: Verdict;
	identity: IdentityPolicy;
	loader: PolicyLoader;
	policyProfile: string;
	policyVersion: string;
	profile: ResolvedProfile | null;
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
						throw new Error(
							`signature feed unavailable: ${snapshot.errors[0]?.message ?? "unknown feed error"}`,
						);
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
			budgetRules: [],
			budgetVerdict: "block",
			controls: [policyUnavailableControl()],
			failureVerdict: "block",
			identity: { knownGroups: [] },
			loader,
			policyProfile: "unavailable",
			policyVersion: "unavailable",
			profile: null,
			semanticEnabled: false,
			semanticReason: "no valid policy loaded",
		};
	}
	const policy = status.snapshot.policy;
	const enabled = policy.profiles[policy.defaults.profile].enabledControls;
	const assembly = assembleStages(policy, audit, loader);
	return {
		budgetRules: policy.controls.budget.rules,
		budgetVerdict: policy.controls.budget.overBudgetVerdict,
		controls: assembly.controls,
		failureVerdict: policy.defaults.failureVerdict,
		identity: identityPolicyFromDocument(policy.groups),
		loader,
		policyProfile: policy.defaults.profile,
		policyVersion: policy.version,
		profile: resolveProfile(policy, policy.defaults.profile),
		semanticEnabled: enabled.semantic && !assembly.semanticSkipped,
		...(assembly.semanticReason === undefined ? {} : { semanticReason: assembly.semanticReason }),
	};
}

export function getHub(): Promise<Hub> {
	hubPromise ??= createHubAsync();
	return hubPromise;
}

/**
 * The loader behind the live hub: its file watcher keeps detection bound to
 * the active snapshot within a build. Replaced (and stopped) on every hub
 * rebuild so repeated policy edits do not accumulate watchers.
 */
let activeLoader: PolicyLoader | undefined;

/**
 * Makes UI policy edits take effect without a restart. Drops the cached hub
 * so the next `getHub()` rebuilds the pipeline from the policy file on
 * disk — which is also what carries the per-build snapshots (`resolveProfile`
 * thresholds, allowlist, signature config, identity, verdicts). Detection
 * needs no refresh (it re-reads the loader snapshot per inspection), but the
 * rebuild keeps its binding pointed at a live loader.
 *
 * Call this once after a policy write (e.g. at the end of `POST /api/policy`)
 * — never in the request path itself, and never via a file watcher there:
 * the rebuild re-reads the file on demand. In-flight requests already hold
 * their hub reference and finish on the old pipeline. If the rewritten file
 * is invalid the rebuild fails closed to `policyUnavailableControl()`, as a
 * fresh boot would.
 */
export function refreshHubAfterPolicyWrite(): void {
	hubPromise = undefined;
}

async function createHubAsync(): Promise<Hub> {
	const {
		budgetRules,
		budgetVerdict,
		identity,
		controls,
		failureVerdict,
		loader,
		policyProfile,
		policyVersion,
		profile,
		semanticEnabled,
		semanticReason,
	} = await buildControls(getAuditSink());
	// Swap watchers only once the replacement is fully built, so the hub being
	// replaced keeps live detection until handover. In-flight requests finish
	// on the old hub; the old loader stops only here.
	activeLoader?.stop();
	activeLoader = loader;
	gatewayBudgetRules = budgetRules;
	hubStatus = {
		policy: { profile: policyProfile, version: policyVersion },
		semantic:
			semanticReason === undefined
				? { enabled: semanticEnabled }
				: { enabled: semanticEnabled, reason: semanticReason },
	};
	await startToolPolicy(getAuditSink());
	return createHub({
		audit: getAuditSink(),
		config: createHubConfig({
			egressAllowlist: parseAllowlist(env.MCP_EGRESS_ALLOWLIST),
			identity,
		}),
		pipeline: createControlPipeline({
			budgetVerdict,
			controls,
			failureVerdict,
			...(profile === null ? {} : { profile }),
		}),
		toolAccess: getToolPolicyRegistry(),
		toolUsage: persistToolUsage,
	});
}

/**
 * Best-effort durable write of one tool-call row. The hub never blocks on the
 * database: without `DATABASE_URL` (tests, local dev) the import throws and
 * the in-memory audit sink stays the record.
 */
function persistToolUsage(record: ToolUsageRecord): void {
	const policyVersion = getToolPolicyRegistry().version ?? "unavailable";
	import("#/db/index.ts")
		.then(({ db }) => recordToolCall(db, { ...record, policyVersion }))
		.catch(() => undefined);
}

/** Load `policy.mcp.json` once and hot-reload it; absence keeps grant defaults. */
async function startToolPolicy(audit: AuditSink): Promise<void> {
	const store = createFileToolPolicyStore(env.MCP_TOOL_POLICY_PATH ?? "policy.mcp.json");
	const registry = getToolPolicyRegistry();
	const status = await store.start();
	if (status.ok) {
		registry.update(status.snapshot);
	} else {
		audit.record(
			auditEvent("failure", {
				controlId: "tool-policy",
				detail: `tool policy unavailable, using grant defaults: ${status.issues[0]?.message ?? "unknown error"}`,
			}),
		);
	}
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
				persistAuditEvent(event);
			},
		};
	} catch {
		return memory;
	}
}

let usageLedger: UsageLedger | undefined;
let gatewayBudgetRules: readonly BudgetRule[] = [];
let priceTable: ModelPriceTable | null = null;
let priceTableLoaded = false;

/** Process-wide usage ledger: spend attribution backing budget enforcement. */
export function getUsageLedger(): UsageLedger {
	usageLedger ??= new UsageLedger();
	return usageLedger;
}

/**
 * LiteLLM price table, fetched once and cached. A failed fetch resolves to
 * null (cost recorded as unknown) so gating continues; the failure is
 * reported on stderr and retried on the next request.
 */
export async function getModelPrices(): Promise<ModelPriceTable | null> {
	if (priceTableLoaded) {
		return priceTable;
	}
	try {
		priceTable = await fetchPriceTable(fetch);
	} catch (error) {
		process.stderr.write(
			`model price table unavailable: ${error instanceof Error ? error.message : String(error)}; recording cost as unknown\n`,
		);
		return null;
	}
	priceTableLoaded = true;
	return priceTable;
}

function upstreamFromEnv(): UpstreamConfig | null {
	if (env.MODEL_BASE_URL === undefined) {
		return null;
	}
	const upstream: UpstreamConfig = { baseUrl: env.MODEL_BASE_URL };
	if (env.MODEL_API_KEY !== undefined) {
		return { ...upstream, apiKey: env.MODEL_API_KEY };
	}
	return upstream;
}

/** Fully-wired gateway dependencies: hub pipeline and identity, ledger, prices, upstream. */
export async function getGatewayDeps(): Promise<GatewayDeps> {
	const hub = await getHub();
	return {
		audit: getAuditSink(),
		identity: hub.identity,
		ledger: getUsageLedger(),
		pipeline: hub.pipeline,
		policyBudgetRules: gatewayBudgetRules,
		prices: getModelPrices,
		upstream: upstreamFromEnv(),
	};
}

/**
 * Best-effort durable write of one governance decision to SQLite. Only
 * decisions (`kind: "interaction"` with a verdict) persist — registration
 * admissions, control failures, and verdict-less notes stay in the memory and
 * JSONL trail, otherwise one guard call would show up as several dashboard
 * rows. The hub never blocks on the database: the write is fire-and-forget,
 * and without a writable database the memory and JSONL sinks stay the record.
 */
function persistAuditEvent(event: AuditEvent): void {
	if (!isAuditDecision(event)) {
		return;
	}
	import("#/db/audit-repo.ts")
		.then(async ({ insertAuditEvent }) => {
			const { getDb } = await import("#/db/index.ts");
			await insertAuditEvent(getDb(), event);
		})
		.catch(() => undefined);
}

function parseAllowlist(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}
