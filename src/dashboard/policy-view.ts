/**
 * Policy-to-dashboard projection: the "controls and strictness profiles in
 * force" plus the version stamps the spec requires on every dashboard view.
 * Pure so the mapping is unit-testable against the sample policy documents.
 */

import type { PolicySnapshot } from "#/control/policy/loader.ts";
import type { Policy } from "#/control/policy/schema.ts";
import { SEMANTIC_DEFAULTS } from "#/control/semantic/config.ts";
import type {
	ControlSummary,
	ControlTier,
	ProfileSummary,
	ThresholdControl,
} from "#/dashboard/types.ts";

const PROFILE_NAMES = ["permissive", "standard", "strict"] as const;

const THRESHOLD_CONTROLS: readonly ThresholdControl[] = ["detection", "semantic", "signatures"];

function controlRows(policy: Policy): ControlSummary[] {
	const { controls } = policy;
	const builtinCount = Object.values(controls.detection.builtins).filter(Boolean).length;
	const semanticCount = SEMANTIC_DEFAULTS.checks.length;
	const rows: Array<{ detail: string; enabled: boolean; id: string; tier: ControlTier }> = [
		{
			detail: `payloads up to ${controls.shape.maxContentBytes} bytes`,
			enabled: true,
			id: "shape",
			tier: "shape",
		},
		{
			detail: `models: ${controls.allowlist.models.map((model) => model.name).join(", ")}`,
			enabled: true,
			id: "allowlist",
			tier: "allowlist",
		},
		{
			detail: `${builtinCount} built-in families, ${controls.detection.rules.length} custom rules`,
			enabled: true,
			id: "detection",
			tier: "detection",
		},
		{
			detail: controls.redaction.enabled ? "typed placeholder redaction" : "disabled",
			enabled: controls.redaction.enabled,
			id: "redaction",
			tier: "redaction",
		},
		{
			detail: `${semanticCount} semantic checks (policy.jev.json)`,
			enabled: semanticCount > 0,
			id: "semantic",
			tier: "semantic",
		},
		{
			detail: `severity actions over the signature feed, suspect threshold ${controls.signatures.suspect.threshold}`,
			enabled: controls.signatures.enabled,
			id: "signatures",
			tier: "signatures",
		},
		{
			detail: `${controls.budget.rules.length} rules, over-budget verdict: ${controls.budget.overBudgetVerdict}`,
			enabled: controls.budget.rules.length > 0,
			id: "budget",
			tier: "budget",
		},
	];
	return rows;
}

function profileRows(policy: Policy): ProfileSummary[] {
	return PROFILE_NAMES.map((name) => {
		const profile = policy.profiles[name];
		const blockThresholds = Object.fromEntries(
			THRESHOLD_CONTROLS.map((control) => [
				control,
				{
					inbound: profile.thresholds[control].inbound.block,
					outbound: profile.thresholds[control].outbound.block,
				},
			]),
		) as ProfileSummary["blockThresholds"];
		return {
			blockThresholds,
			enabled: profile.enabledControls,
			name,
		};
	});
}

/** Project a validated policy snapshot into the dashboard's policy view. */
export function summarizePolicy(
	snapshot: PolicySnapshot,
	feedVersion: string,
): {
	feedVersion: string;
	policy: import("#/dashboard/types.ts").PolicyView;
	policyVersion: string;
} {
	const { policy, policyVersion } = snapshot;
	const consumers = Object.fromEntries(
		Object.entries(policy.consumers).map(([key, consumer]) => [key, consumer.profile]),
	);
	return {
		feedVersion,
		policy: {
			consumers,
			controls: controlRows(policy),
			defaultProfile: policy.defaults.profile,
			failureVerdict: policy.defaults.failureVerdict,
			profiles: profileRows(policy),
		},
		policyVersion,
	};
}
