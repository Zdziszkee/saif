import { describe, expect, it } from "bun:test";
import { parsePolicy } from "#/control/policy/schema.ts";
import { cloneBase, firstOf } from "./policy-fixtures.ts";

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
