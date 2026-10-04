/**
 * The fail-closed result used when no valid policy is loaded.
 *
 * The live detection control and the hub's fallback pipeline each need
 * the same blocking `policy-unavailable` outcome; one constructor keeps
 * the control id, detail, and verdict identical.
 */

import type { Control, ControlResult } from "../types.ts";

/** Blocking `policy-unavailable` result: no valid policy is loaded. */
export function policyUnavailableResult(): ControlResult {
	return {
		hit: {
			controlId: "policy-unavailable",
			detail: "no valid policy loaded",
			kind: "policy",
			verdict: "block",
		},
		verdict: "block",
	};
}

/** Standalone control returning the unavailable result on every inspection. */
export function policyUnavailableControl(): Control {
	return {
		id: "policy-unavailable",
		inspect: (): ControlResult => policyUnavailableResult(),
	};
}
