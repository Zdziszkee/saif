/**
 * Dashboard gap helpers: policy/signature versions, escalation queue, and
 * controls in force. Pure shaping lives here so the dashboard route stays
 * thin; the server sketch at the bottom follows the hub runtime's
 * lazy-singleton pattern (no file watches at import).
 */

import { filterByConsumerKey } from "#/components/dashboard-consumers.ts";
import { type AuditEvent, filterAuditEvents, isAuditDecision } from "#/control/audit.ts";
import { FilePolicySource, PolicyLoader } from "#/control/policy/loader.ts";
import type { Policy } from "#/control/policy/schema.ts";
import { createSignatureFeedStore, type SignatureFeedStore } from "#/control/signatures/feed.ts";

export const DEFAULT_ESCALATION_LIMIT = 20;
export const UNKNOWN_PROFILE = "unknown";
export const UNKNOWN_VERSION = "unknown";

const FULL_SHA256 = /^[0-9a-f]{64}$/;
const POLICY_PATH = "policy.json";
const SHORT_HASH_LENGTH = 12;
const SIGNATURES_PATH = "signatures.json";

/** Policy + signature feed versions in dashboard display form. */
export interface DashboardVersions {
	readonly feed: string;
	readonly policy: string;
}

/** Active strictness profile plus the pipeline controls it enables. */
export interface ControlsInForce {
	readonly enabled: readonly string[];
	readonly profile: string;
}

/** Loader input: audit events plus dashboard scoping. */
export interface LoadDashboardMetaInput {
	readonly consumer?: string | undefined;
	readonly escalationLimit?: number | undefined;
	readonly events?: readonly AuditEvent[] | undefined;
}

/** Shaped meta for the Versions + Escalations + Controls cards. */
export interface DashboardMeta {
	readonly controls: ControlsInForce;
	readonly escalations: readonly AuditEvent[];
	readonly versions: DashboardVersions;
}

/**
 * Escalation queue: `escalate`-verdict decisions, newest first, capped at
 * `limit`. Applies the dashboard `?consumer=` scoping when set (same
 * `filterByConsumerKey` the loader uses), so a scoped dashboard shows only
 * that consumer's escalations.
 */
export function selectEscalations(
	events: readonly AuditEvent[] | undefined,
	limit: number = DEFAULT_ESCALATION_LIMIT,
	consumer?: string | undefined,
): AuditEvent[] {
	const capped = Math.floor(limit);
	if (!Number.isFinite(limit) || capped <= 0) {
		return [];
	}
	const scoped = filterByConsumerKey(events ?? [], consumer);
	const decisions = scoped.filter(isAuditDecision);
	return filterAuditEvents(decisions, { verdict: "escalate" }).slice(-capped).reverse();
}

function displayVersion(value: string | undefined): string {
	if (value === undefined) {
		return UNKNOWN_VERSION;
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return UNKNOWN_VERSION;
	}
	if (FULL_SHA256.test(trimmed)) {
		return trimmed.slice(0, SHORT_HASH_LENGTH);
	}
	return trimmed;
}

/**
 * Version chips: full SHA-256 stamps shorten to 12 hex chars, short labels
 * (e.g. the feed store's `"unavailable"` state) pass through, and
 * missing/blank reads as unknown.
 */
export function formatVersions(
	policyVersion?: string | undefined,
	feedVersion?: string | undefined,
): DashboardVersions {
	return { feed: displayVersion(feedVersion), policy: displayVersion(policyVersion) };
}

/**
 * Controls in force: the default profile's enabled-control flags in pipeline
 * order (allowlist always runs; see `buildControls` in hub/runtime.ts).
 * Unknown with no controls when no valid policy is loaded.
 */
export function summarizeControlsInForce(policy: Policy | undefined): ControlsInForce {
	if (policy === undefined) {
		return { enabled: [], profile: UNKNOWN_PROFILE };
	}
	const profile = policy.defaults.profile;
	const flags = policy.profiles[profile].enabledControls;
	const enabled: string[] = ["allowlist"];
	if (flags.signatures) {
		enabled.push("signatures");
	}
	if (flags.detection) {
		enabled.push("detection");
	}
	if (flags.semantic) {
		enabled.push("semantic");
	}
	return { enabled, profile };
}

let policyLoader: PolicyLoader | undefined;
let policyStarted = false;
let feedStore: SignatureFeedStore | undefined;

/** Lazy singleton: constructing the loader is cheap, starting it watches. */
function getPolicyLoader(): PolicyLoader {
	policyLoader ??= new PolicyLoader(new FilePolicySource(POLICY_PATH));
	return policyLoader;
}

/** Lazy singleton: mirrors `getSignatureFeedStore` in hub/runtime.ts. */
function getFeedStore(): SignatureFeedStore {
	feedStore ??= createSignatureFeedStore(SIGNATURES_PATH);
	return feedStore;
}

/**
 * Server-only sketch: reads the PolicyLoader snapshot + feed store without
 * import-time side effects and shapes the cards from caller-supplied audit
 * events (the dashboard loader already holds them from the sink).
 */
export async function loadDashboardMeta(
	input: LoadDashboardMetaInput = {},
): Promise<DashboardMeta> {
	const loader = getPolicyLoader();
	if (!policyStarted) {
		await loader.start();
		policyStarted = true;
	}
	const snapshot = loader.snapshot;
	const feed = getFeedStore().snapshot();
	return {
		controls: summarizeControlsInForce(snapshot?.policy),
		escalations: selectEscalations(input.events, input.escalationLimit, input.consumer),
		versions: formatVersions(snapshot?.policyVersion, feed.feed.version),
	};
}
