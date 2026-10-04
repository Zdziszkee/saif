import { describe, expect, it } from "bun:test";
import { parsePolicy } from "#/control/policy/schema.ts";
import { cloneBase, firstOf } from "./policy-fixtures.ts";

// Editor scope helpers live here (in the test file) because the UI editor
// module does not exist yet. They mirror the backend contract:
// - canonicalJson mirrors src/control/policy/loader.ts (sorted object keys,
//   array order preserved, hashed into policyVersion)
// - isStale mirrors optimistic-concurrency on policyVersion (baseVersion check)
// - findDuplicateRuleIds mirrors the duplicate-id superRefine in
//   src/control/policy/schema.ts
// All secret-shaped values below are deliberately fake fixtures — never real
// credentials.

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value).sort(([left], [right]) => {
			if (left === right) {
				return 0;
			}
			return left < right ? -1 : 1;
		});
		return `{${entries
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function isDirty(saved: unknown, draft: unknown): boolean {
	return canonicalJson(saved) !== canonicalJson(draft);
}

function isStale(baseVersion: string, currentVersion: string): boolean {
	return baseVersion !== currentVersion;
}

function findDuplicateRuleIds(ids: readonly string[]): string[] {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const id of ids) {
		if (seen.has(id)) {
			duplicates.add(id);
		}
		seen.add(id);
	}
	return [...duplicates].sort();
}

describe("policy editor scope: canonical JSON round-trip", () => {
	it("is stable under key reordering", () => {
		const first: unknown = { a: 1, b: { c: 2, d: 3 } };
		const reordered: unknown = JSON.parse('{"b":{"d":3,"c":2},"a":1}');
		expect(canonicalJson(first)).toBe(canonicalJson(reordered));
	});

	it("preserves array order", () => {
		expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
	});

	it("round-trips a policy document through parse and stringify", () => {
		const base = cloneBase();
		const parsed = parsePolicy(base);
		if (!parsed.success) {
			throw new Error("expected a valid document");
		}
		const revived: unknown = JSON.parse(canonicalJson(parsed.policy));
		expect(parsePolicy(revived).success).toBe(true);
		expect(canonicalJson(revived)).toBe(canonicalJson(parsed.policy));
	});

	it("distinguishes semantically different documents", () => {
		const base = cloneBase();
		const toggled = cloneBase();
		toggled.controls.enabled = !base.controls.enabled;
		expect(canonicalJson(base)).not.toBe(canonicalJson(toggled));
	});
});

describe("policy editor scope: dirty check via canonical JSON", () => {
	it("is clean when the draft only reorders keys", () => {
		const saved = cloneBase();
		const draft: unknown = JSON.parse(canonicalJson(saved));
		expect(isDirty(saved, draft)).toBe(false);
	});

	it("is dirty when enabled is toggled", () => {
		const saved = cloneBase();
		const draft = cloneBase();
		draft.controls.enabled = !saved.controls.enabled;
		expect(isDirty(saved, draft)).toBe(true);
	});

	it("is dirty when a detection rule is added", () => {
		const saved = cloneBase();
		const draft = cloneBase();
		draft.controls.detection.rules.push({
			action: "redact",
			directions: ["inbound"],
			id: "ui-draft-fake-rule",
			kind: "secret",
			pattern: "\\bFAKE-DRAFT-[0-9]{4}\\b",
		});
		expect(isDirty(saved, draft)).toBe(true);
	});

	it("is clean again after reverting the draft", () => {
		const saved = cloneBase();
		const draft = cloneBase();
		draft.controls.enabled = !saved.controls.enabled;
		expect(isDirty(saved, draft)).toBe(true);
		const reverted = structuredClone(saved);
		expect(isDirty(saved, reverted)).toBe(false);
	});
});

describe("policy editor scope: baseVersion stale detection", () => {
	it("is fresh when versions match", () => {
		expect(isStale("v1", "v1")).toBe(false);
	});

	it("is stale when the server advanced past the draft base", () => {
		expect(isStale("v1", "v2")).toBe(true);
	});

	it("is stale when the draft base differs in either direction", () => {
		expect(isStale("v2", "v1")).toBe(true);
		expect(isStale("", "v1")).toBe(true);
	});
});

describe("policy editor scope: duplicate-id detector", () => {
	it("finds no duplicates on the base fixture", () => {
		const base = cloneBase();
		const ids = base.controls.detection.rules.map((rule) => rule.id);
		expect(findDuplicateRuleIds(ids)).toEqual([]);
	});

	it("flags a duplicated rule id", () => {
		const base = cloneBase();
		const ids = base.controls.detection.rules.map((rule) => rule.id);
		const duplicated = [...ids, firstOf(ids)];
		expect(findDuplicateRuleIds(duplicated)).toEqual([firstOf(ids)]);
	});

	it("is empty for an empty rule list", () => {
		expect(findDuplicateRuleIds([])).toEqual([]);
	});
});
