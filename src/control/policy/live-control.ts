/**
 * Binds deterministic enforcement to the policy loader's active snapshot.
 *
 * The pipeline runs controls that are fixed at construction, so a detection
 * control built from one snapshot would keep enforcing that snapshot after a
 * hot reload. `createLiveDetectionControl` re-reads the active detection
 * configuration on every inspection and rebuilds itself when the policy
 * version changes, so a reloaded policy takes effect on the next interaction
 * without a restart. With no valid policy loaded, it fails closed.
 */

import { createDeterministicControl } from "#/control/deterministic/control.ts";
import { policyUnavailableResult } from "#/control/policy/unavailable.ts";
import type { Control, ControlResult, Interaction } from "#/control/types.ts";
import type { DetectionConfig } from "./schema.ts";

/** The detection configuration in force, stamped with its policy version. */
export interface ActiveDetection {
	config: DetectionConfig;
	policyVersion: string;
}

export function createLiveDetectionControl(getActive: () => ActiveDetection | undefined): Control {
	let bound: { control: Control; policyVersion: string } | undefined;
	return {
		id: "deterministic",
		inspect: (interaction: Interaction): ControlResult | Promise<ControlResult> => {
			const active = getActive();
			if (active === undefined) {
				return policyUnavailableResult();
			}
			if (bound === undefined || bound.policyVersion !== active.policyVersion) {
				bound = {
					control: createDeterministicControl(active.config),
					policyVersion: active.policyVersion,
				};
			}
			return bound.control.inspect(interaction);
		},
	};
}
