import { describe, expect, it } from "bun:test";
import { parsePolicy } from "#/control/policy/schema.ts";
import { cloneBase, firstOf } from "./policy-fixtures.ts";

// All secret-shaped values below are deliberately fake fixtures
// (FAKE- prefixes, example.com endpoints) — never real credentials.

describe("policy UI validation: minimal edits", () => {
	it("accepts toggling controls.enabled off", () => {
		const base = cloneBase();
		base.controls.enabled = false;
		const result = parsePolicy(base);
		expect(result.success).toBe(true);
	});

	it("accepts adding an allowlist model", () => {
		const base = cloneBase();
		base.controls.allowlist.models.push({
			endpoint: "https://api.example.com/v2",
			name: "secondary",
		});
		const result = parsePolicy(base);
		expect(result.success).toBe(true);
	});

	it("accepts adding a detection rule", () => {
		const base = cloneBase();
		base.controls.detection.rules.push({
			action: "redact",
			directions: ["inbound"],
			id: "ui-added-fake-secret",
			kind: "secret",
			pattern: "\\bFAKE-SECRET-[0-9]{4}\\b",
		});
		const result = parsePolicy(base);
		expect(result.success).toBe(true);
	});

	it("accepts changing a threshold within [0, 1]", () => {
		const base = cloneBase();
		base.profiles.standard.thresholds.detection.inbound.block = 0.9;
		const result = parsePolicy(base);
		expect(result.success).toBe(true);
	});
});

describe("policy UI validation: rejected edits", () => {
	it("rejects a duplicate detection rule id", () => {
		const base = cloneBase();
		base.controls.detection.rules.push(structuredClone(firstOf(base.controls.detection.rules)));
		const result = parsePolicy(base);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.issues.map((issue) => issue.message).join("; ")).toContain(
				`duplicate detection rule id: ${firstOf(base.controls.detection.rules).id}`,
			);
		}
	});

	it("rejects a catastrophic-backtracking pattern", () => {
		const base = cloneBase();
		firstOf(base.controls.detection.rules).pattern = "(a+)+";
		expect(parsePolicy(base).success).toBe(false);
	});

	it("rejects a pattern with an excessive repeat count", () => {
		const base = cloneBase();
		firstOf(base.controls.detection.rules).pattern = "a{5000,}";
		expect(parsePolicy(base).success).toBe(false);
	});

	it("rejects unknown keys", () => {
		expect(parsePolicy({ ...cloneBase(), unexpected: true }).success).toBe(false);
		const base = cloneBase();
		const nested: unknown = {
			...base,
			controls: {
				...base.controls,
				shape: { maxContentBytes: 65_536, unknownKey: 1 },
			},
		};
		expect(parsePolicy(nested).success).toBe(false);
	});

	it("rejects a threshold above 1", () => {
		const base = cloneBase();
		base.profiles.standard.thresholds.detection.inbound.block = 1.5;
		expect(parsePolicy(base).success).toBe(false);
	});

	it("rejects an empty allowlist model list", () => {
		const base = cloneBase();
		base.controls.allowlist.models = [];
		expect(parsePolicy(base).success).toBe(false);
	});
});
