import { describe, expect, it } from "bun:test";

import {
	type ApplyPolicyInput,
	applyPolicy,
	ladderVerdict,
	resolveProfile,
} from "#/control/policy/apply.ts";
import { parsePolicy } from "#/control/policy/schema.ts";
import policyDocument from "../policy.json" with { type: "json" };

const Ladder = { block: 0.85, escalate: 0.4, redact: 0.6 };
const PROMPT_INJECTION_CHECK = "prompt_injection";

function baseInput(overrides: Partial<ApplyPolicyInput> = {}): ApplyPolicyInput {
	const parsed = parsePolicy(policyDocument);
	if (!parsed.success) {
		throw new Error("shipped policy.json failed validation");
	}
	return {
		budget: { overBudget: false, overBudgetVerdict: "block" },
		detections: [],
		direction: "inbound",
		profile: resolveProfile(parsed.policy, "standard"),
		semantic: {},
		signatures: [],
		...overrides,
	};
}

describe("ladderVerdict", () => {
	it("pins every cutoff boundary", () => {
		expect(ladderVerdict(0.85, Ladder)).toBe("block");
		expect(ladderVerdict(0.849, Ladder)).toBe("redact");
		expect(ladderVerdict(0.6, Ladder)).toBe("redact");
		expect(ladderVerdict(0.599, Ladder)).toBe("escalate");
		expect(ladderVerdict(0.4, Ladder)).toBe("escalate");
		expect(ladderVerdict(0.399, Ladder)).toBe("allow");
		expect(ladderVerdict(0, Ladder)).toBe("allow");
	});

	it("fails closed on unusable probabilities", () => {
		expect(ladderVerdict(Number.NaN, Ladder)).toBe("block");
		expect(ladderVerdict(1.5, Ladder)).toBe("block");
		expect(ladderVerdict(-0.2, Ladder)).toBe("block");
	});
});

describe("resolveProfile", () => {
	it("merges consumer overrides over the named base", () => {
		const parsed = parsePolicy(policyDocument);
		if (!parsed.success) {
			throw new Error("shipped policy.json failed validation");
		}
		const resolved = resolveProfile(parsed.policy, "standard", {
			enabledControls: { detection: false, semantic: true, signatures: true },
			thresholds: { semantic: { inbound: { block: 0.5, escalate: 0.4, redact: 0.6 } } },
		});
		expect(resolved.name).toBe("standard");
		expect(resolved.enabledControls.detection).toBe(false);
		expect(resolved.enabledControls.semantic).toBe(true);
		expect(resolved.thresholds.semantic.inbound.block).toBe(0.5);
		expect(resolved.thresholds.semantic.outbound.block).toBe(0.85);
		expect(resolved.thresholds.detection.inbound.block).toBe(0.85);
	});
});

describe("applyPolicy", () => {
	it("allows a clean sweep with no attribution", () => {
		expect(applyPolicy(baseInput())).toEqual({ flagged: false, verdict: "allow" });
	});

	it("lets the worst discrete action win with first-wins ties", () => {
		const decision = applyPolicy(
			baseInput({
				detections: [
					{ action: "redact", control: "deterministic", kind: "pii.email" },
					{ action: "block", control: "signatures", kind: "jailbreak" },
				],
				signatures: [{ action: "block", control: "allowlist", kind: "model" }],
			}),
		);
		expect(decision.verdict).toBe("block");
		expect(decision.blockingControl).toBe("signatures");
		expect(decision.flagged).toBe(false);
	});

	it("maps flag to raised-but-forwarded (WARN)", () => {
		const decision = applyPolicy(
			baseInput({
				detections: [{ action: "flag", control: "deterministic", kind: "custom" }],
			}),
		);
		expect(decision).toEqual({ blockingControl: "deterministic", flagged: true, verdict: "allow" });
	});

	it("composes raised with redacted", () => {
		const decision = applyPolicy(
			baseInput({
				detections: [
					{ action: "redact", control: "deterministic", kind: "pii.email" },
					{ action: "flag", control: "deterministic", kind: "custom" },
				],
			}),
		);
		expect(decision.verdict).toBe("redact");
		expect(decision.flagged).toBe(true);
		expect(decision.blockingControl).toBe("deterministic");
	});

	it("maps semantic probabilities through the profile ladder", () => {
		expect(applyPolicy(baseInput({ semantic: { [PROMPT_INJECTION_CHECK]: 0.9 } })).verdict).toBe(
			"block",
		);
		expect(applyPolicy(baseInput({ semantic: { [PROMPT_INJECTION_CHECK]: 0.7 } })).verdict).toBe(
			"redact",
		);
		expect(applyPolicy(baseInput({ semantic: { [PROMPT_INJECTION_CHECK]: 0.5 } })).verdict).toBe(
			"escalate",
		);
		expect(applyPolicy(baseInput({ semantic: { [PROMPT_INJECTION_CHECK]: 0.1 } })).verdict).toBe(
			"allow",
		);
	});

	it("fails closed on unusable semantic evidence", () => {
		const decision = applyPolicy(baseInput({ semantic: { [PROMPT_INJECTION_CHECK]: Number.NaN } }));
		expect(decision.verdict).toBe("block");
		expect(decision.blockingControl).toBe("semantic");
	});

	it("maps an exhausted budget to the over-budget verdict", () => {
		const decision = applyPolicy(
			baseInput({ budget: { overBudget: true, overBudgetVerdict: "block" } }),
		);
		expect(decision.verdict).toBe("block");
		expect(decision.blockingControl).toBe("budget");
	});

	it("counts other-tier evidence (allowlist, fallbacks) in worst-wins", () => {
		const decision = applyPolicy(
			baseInput({
				other: [{ action: "block", control: "allowlist", kind: "model" }],
			}),
		);
		expect(decision.verdict).toBe("block");
		expect(decision.blockingControl).toBe("allowlist");
	});

	it("yields different verdicts under permissive and strict from one shared fixture", () => {
		const parsed = parsePolicy(policyDocument);
		if (!parsed.success) {
			throw new Error("shipped policy.json failed validation");
		}
		const shared = {
			budget: { overBudget: false, overBudgetVerdict: "block" as const },
			detections: [],
			direction: "inbound" as const,
			semantic: { [PROMPT_INJECTION_CHECK]: 0.8 },
			signatures: [],
		};
		const permissive = applyPolicy({
			...shared,
			profile: resolveProfile(parsed.policy, "permissive"),
		});
		const strict = applyPolicy({
			...shared,
			profile: resolveProfile(parsed.policy, "strict"),
		});
		expect(permissive.verdict).toBe("redact");
		expect(strict.verdict).toBe("block");
		expect(permissive.blockingControl).toBe("semantic");
		expect(strict.blockingControl).toBe("semantic");
	});
});
