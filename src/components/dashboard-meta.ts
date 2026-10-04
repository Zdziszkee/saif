/**
 * Dashboard gap helpers: policy/signature versions, escalation queue, and
 * controls in force.
 *
 * Audit-layer pure shaping over raw `AuditEvent[]` plus a compact
 * policy summary. The dashboard route does NOT use this module: it renders
 * master's shaped `DashboardData` via `src/dashboard/data.ts`
 * (`buildDashboardData`, `selectMetrics`, `selectEscalations`) fed by
 * `getDashboardData` in `src/dashboard/server.ts`. Everything kept here
 * differs from master's equivalents (see per-export notes) and is pinned by
 * `tests/dashboard-meta.test.ts`, so it stays as documented audit-layer
 * utilities. Server reads are owned by `src/dashboard/server.ts`; this
 * module holds no loader, feed store, or singleton.
 */

import { filterByConsumerKey } from "#/components/dashboard-consumers.ts";
import { type AuditEvent, filterAuditEvents, isAuditDecision } from "#/control/audit.ts";
import type { Policy } from "#/control/policy/schema.ts";

export const DEFAULT_ESCALATION_LIMIT = 20;
export const UNKNOWN_PROFILE = "unknown";
export const UNKNOWN_VERSION = "unknown";

const FULL_SHA256 = /^[0-9a-f]{64}$/;
const SHORT_HASH_LENGTH = 12;

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

/**
 * Escalation queue over raw audit events: `escalate`-verdict decisions,
 * newest first, capped at `limit`. Applies the dashboard `?consumer=`
 * scoping when set (same `filterByConsumerKey` the audit layer uses), so a
 * scoped dashboard shows only that consumer's escalations.
 *
 * Audit-layer utility, not master's view selector: master's
 * `selectEscalations` in `src/dashboard/data.ts` takes a shaped
 * `DashboardData` plus an `"all"` scope and returns `EscalationRow[]`,
 * while this takes raw `AuditEvent[]` plus a numeric limit and returns
 * `AuditEvent[]`. Pinned by `tests/dashboard-meta.test.ts` and also
 * consumed by `tests/dashboard-gaps-per-consumer.test.ts`.
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
 *
 * Audit-layer utility with no master equivalent: master's dashboard trims
 * inline (`policyVersion.slice(0, 12)` in
 * `src/components/dashboard/dashboard.tsx`) and passes the feed version
 * through raw, with no blank-to-unknown mapping. Pinned by
 * `tests/dashboard-meta.test.ts`.
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
 *
 * Audit-layer utility with no master equivalent: master's
 * `summarizePolicy` in `src/dashboard/policy-view.ts` projects the full
 * `PolicyView` (seven `ControlSummary` rows plus `ProfileSummary` rows),
 * while this returns the compact `{ enabled, profile }` flag list. Pinned
 * by `tests/dashboard-meta.test.ts`.
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
