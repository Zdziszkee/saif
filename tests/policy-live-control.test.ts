/**
 * The live detection control rebinds to the active policy version on every
 * inspection: a policy reload changes enforcement on the next interaction
 * without a restart, and no valid policy fails closed.
 */
import { describe, expect, test } from "bun:test";

import { type ActiveDetection, createLiveDetectionControl } from "#/control/policy/live-control.ts";
import type { DetectionConfig } from "#/control/policy/schema.ts";
import type { Interaction } from "#/control/types.ts";

function detection(rules: DetectionConfig["rules"]): DetectionConfig {
	return {
		builtins: {
			encodingRescan: false,
			entropyScan: false,
			genericCredentials: false,
			pii: false,
			providerSecrets: false,
		},
		defaultActions: { custom: "block" },
		rules,
	};
}

function probeRule(pattern: string): DetectionConfig["rules"][number] {
	return {
		action: "block",
		directions: ["inbound", "outbound"],
		id: "probe",
		kind: "custom",
		pattern,
	};
}

function markerInteraction(content: string): Interaction {
	return { content, direction: "inbound", id: "test-1", seam: "guard-api", subject: "alice" };
}

describe("createLiveDetectionControl", () => {
	test("enforces the active policy version and follows reloads without a restart", async () => {
		let active: ActiveDetection | undefined = {
			config: detection([probeRule("marker")]),
			policyVersion: "v1",
		};
		const control = createLiveDetectionControl(() => active);
		const inspect = (content: string) =>
			Promise.resolve(control.inspect(markerInteraction(content)));

		expect((await inspect("marker")).verdict).toBe("block");
		expect((await inspect("benign")).verdict).toBe("allow");

		active = { config: detection([]), policyVersion: "v2" };
		expect((await inspect("marker")).verdict).toBe("allow");

		active = { config: detection([probeRule("marker")]), policyVersion: "v3" };
		expect((await inspect("marker")).verdict).toBe("block");
	});

	test("fails closed while no valid policy is loaded", async () => {
		let active: ActiveDetection | undefined;
		const control = createLiveDetectionControl(() => active);

		const result = await Promise.resolve(control.inspect(markerInteraction("benign")));
		expect(result.verdict).toBe("block");
		expect(result.hit?.controlId).toBe("policy-unavailable");

		active = { config: detection([]), policyVersion: "v1" };
		expect((await Promise.resolve(control.inspect(markerInteraction("benign")))).verdict).toBe(
			"allow",
		);
	});
});
