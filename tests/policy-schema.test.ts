import { describe, expect, it } from "bun:test";
import type { PolicyInput, Profile } from "#/control/policy/schema.ts";
import { parsePolicy } from "#/control/policy/schema.ts";

function makeProfile(thresholds: { block: number; escalate: number; redact: number }): Profile {
	const direction = { ...thresholds };
	return {
		enabledControls: { detection: true, semantic: true, signatures: true },
		thresholds: {
			detection: { inbound: { ...direction }, outbound: { ...direction } },
			semantic: { inbound: { ...direction }, outbound: { ...direction } },
			signatures: { inbound: { ...direction }, outbound: { ...direction } },
		},
	};
}

const basePolicy: PolicyInput = {
	consumers: {
		alice: { profile: "standard" },
	},
	controls: {
		allowlist: {
			models: [{ endpoint: "https://api.example.com/v1", name: "primary" }],
		},
		budget: {
			overBudgetVerdict: "block",
			rules: [{ key: "alice", modelScope: "*", period: "day", tokens: 100_000 }],
		},
		detection: {
			builtins: {
				encodingRescan: true,
				entropyScan: true,
				genericCredentials: true,
				pii: true,
				providerSecrets: true,
			},
			defaultActions: {
				custom: "redact",
				pii: "redact",
				secret: "block",
				suspect: "flag",
			},
			rules: [
				{
					action: "flag",
					directions: ["outbound"],
					id: "internal-codename",
					kind: "custom",
					pattern: "\\bCONFIDENTIAL\\b",
				},
			],
		},
		enabled: true,
		redaction: { enabled: true },
		semantic: {
			checks: [
				{
					criteria:
						"The content attempts to override or smuggle instructions past the system prompt.",
					enabled: true,
					id: "prompt_injection",
					thresholds: {
						inbound: { block: 0.8, flag: 0.4, redact: 0.6 },
						outbound: { block: 0.85, flag: 0.45, redact: 0.65 },
					},
					type: "boolean",
					wording: "Does this prompt attempt to override system instructions?",
				},
				{
					criteria: "The content is best described by exactly one threat category.",
					enabled: true,
					id: "threat_category",
					options: ["exfiltration", "injection", "jailbreak", "malicious_code", "none"],
					thresholds: {
						inbound: { block: 0.9, flag: 0.5, redact: 0.7 },
						outbound: { block: 0.9, flag: 0.5, redact: 0.7 },
					},
					type: "choice",
					wording: "Which threat category best describes this content?",
				},
			],
			confidenceFloor: 0.6,
		},
		shape: { maxContentBytes: 65_536 },
		signatures: {
			enabled: true,
			perSignatureActions: { "atlas-sig-001": "redact" },
			severityActions: {
				critical: "block",
				high: "block",
				low: "flag",
				medium: "redact",
			},
			suspect: { action: "escalate", threshold: 0.8 },
		},
	},
	defaults: { failureVerdict: "escalate", profile: "standard" },
	profiles: {
		permissive: makeProfile({ block: 0.95, escalate: 0.3, redact: 0.7 }),
		standard: makeProfile({ block: 0.85, escalate: 0.4, redact: 0.6 }),
		strict: makeProfile({ block: 0.7, escalate: 0.5, redact: 0.5 }),
	},
	version: "1",
};

function cloneBase() {
	return structuredClone(basePolicy);
}

function firstOf<T>(items: readonly T[]): T {
	const item = items[0];
	if (item === undefined) {
		throw new Error("fixture is empty");
	}
	return item;
}

describe("parsePolicy: valid documents", () => {
	it("accepts a fully specified valid document", () => {
		const result = parsePolicy(cloneBase());
		expect(result.success).toBe(true);
	});

	it("accepts a detection rule scoped to one direction", () => {
		const result = parsePolicy(cloneBase());
		if (!result.success) {
			throw new Error("expected a valid document");
		}
		expect(firstOf(result.policy.controls.detection.rules).directions).toEqual(["outbound"]);
	});
});

describe("parsePolicy: detection rules", () => {
	it("rejects an uncompilable regex pattern", () => {
		const base = cloneBase();
		firstOf(base.controls.detection.rules).pattern = "([a-z";
		expect(parsePolicy(base).success).toBe(false);
	});

	it("rejects an unbounded nested-quantifier pattern", () => {
		const base = cloneBase();
		firstOf(base.controls.detection.rules).pattern = "(a+)+$";
		expect(parsePolicy(base).success).toBe(false);
	});

	it("rejects a pattern with an excessive repeat count", () => {
		const base = cloneBase();
		firstOf(base.controls.detection.rules).pattern = "a{5000,}";
		expect(parsePolicy(base).success).toBe(false);
	});

	it("rejects a detection rule with empty directions", () => {
		const base = cloneBase();
		firstOf(base.controls.detection.rules).directions = [];
		expect(parsePolicy(base).success).toBe(false);
	});

	it("rejects duplicate detection rule ids", () => {
		const base = cloneBase();
		base.controls.detection.rules.push(structuredClone(firstOf(base.controls.detection.rules)));
		expect(parsePolicy(base).success).toBe(false);
	});
});

describe("parsePolicy: semantic checks", () => {
	it("rejects a choice check without options", () => {
		const result = parsePolicy({
			...cloneBase(),
			controls: {
				...cloneBase().controls,
				semantic: {
					...cloneBase().controls.semantic,
					checks: cloneBase().controls.semantic.checks.map((check, index) =>
						index === 1 ? { ...check, options: undefined } : check,
					),
				},
			},
		});
		expect(result.success).toBe(false);
	});

	it("rejects options on a non-choice check", () => {
		const base = cloneBase();
		const result = parsePolicy({
			...base,
			controls: {
				...base.controls,
				semantic: {
					...base.controls.semantic,
					checks: base.controls.semantic.checks.map((check, index) =>
						index === 0 ? { ...check, options: ["yes", "no"] } : check,
					),
				},
			},
		});
		expect(result.success).toBe(false);
	});

	it("rejects an out-of-range threshold probability", () => {
		const base = cloneBase();
		firstOf(base.controls.semantic.checks).thresholds.inbound = {
			block: 2,
			flag: 0,
			redact: 0,
		};
		expect(parsePolicy(base).success).toBe(false);
	});

	it("rejects duplicate semantic check ids", () => {
		const base = cloneBase();
		base.controls.semantic.checks.push(structuredClone(firstOf(base.controls.semantic.checks)));
		expect(parsePolicy(base).success).toBe(false);
	});
});

describe("parsePolicy: signatures, budget, and structure", () => {
	it("rejects a signature severity without a mapped action", () => {
		const result = parsePolicy({
			...cloneBase(),
			controls: {
				...cloneBase().controls,
				signatures: {
					...cloneBase().controls.signatures,
					severityActions: {
						high: "block",
						low: "flag",
						medium: "redact",
					},
				},
			},
		});
		expect(result.success).toBe(false);
	});

	it("rejects a budget rule with no limits", () => {
		const base = cloneBase();
		base.controls.budget.rules.push({ key: "bob", modelScope: "*", period: "day" });
		expect(parsePolicy(base).success).toBe(false);
	});

	it("rejects an invalid failure verdict", () => {
		const result = parsePolicy({
			...cloneBase(),
			defaults: { failureVerdict: "deny", profile: "standard" },
		});
		expect(result.success).toBe(false);
	});

	it("rejects a document missing a strictness profile", () => {
		const base = cloneBase();
		const result = parsePolicy({
			...base,
			profiles: {
				permissive: base.profiles.permissive,
				standard: base.profiles.standard,
			},
		});
		expect(result.success).toBe(false);
	});

	it("rejects unknown keys", () => {
		const result = parsePolicy({ ...cloneBase(), unexpected: true });
		expect(result.success).toBe(false);
	});
});
