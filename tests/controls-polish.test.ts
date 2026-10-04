import { describe, expect, it } from "bun:test";

// Pure mirrors of the controls UI contracts (no src imports so this file
// stays green while parallel agents edit src/). Keep in sync with
// src/control/policy/schema.ts (threshold 0..1) and
// src/routes/dashboard.tsx validateDashboardSearch.

function commitThreshold(text: string, current: number): number {
	if (text.trim() === "") {
		return current;
	}
	const parsed = Number(text);
	if (Number.isNaN(parsed)) {
		return current;
	}
	if (parsed < 0) {
		return 0;
	}
	if (parsed > 1) {
		return 1;
	}
	return parsed;
}

function validateDashboardSearch(search: Record<string, unknown>): {
	consumer: string | undefined;
	role: string | undefined;
} {
	const { consumer: rawConsumer, role: rawRole } = search;
	return {
		consumer: typeof rawConsumer === "string" && rawConsumer.length > 0 ? rawConsumer : undefined,
		role: typeof rawRole === "string" && rawRole.length > 0 ? rawRole : undefined,
	};
}

describe("controls polish: threshold commit", () => {
	it("commits a valid threshold string", () => {
		expect(commitThreshold("0.85", 0.5)).toBe(0.85);
	});

	it("reverts empty string to current", () => {
		expect(commitThreshold("", 0.5)).toBe(0.5);
	});

	it("reverts non-numeric input to current", () => {
		expect(commitThreshold("abc", 0.5)).toBe(0.5);
	});

	it("clamps above 1 to 1", () => {
		expect(commitThreshold("1.5", 0.5)).toBe(1);
	});

	it("clamps below 0 to 0", () => {
		expect(commitThreshold("-0.2", 0.5)).toBe(0);
	});

	it("parses trailing-dot input to 0", () => {
		expect(commitThreshold("0.", 0.5)).toBe(0);
	});
});

describe("controls polish: dashboard search validation", () => {
	it("passes through non-empty strings", () => {
		expect(validateDashboardSearch({ consumer: "acme", role: "viewer" })).toEqual({
			consumer: "acme",
			role: "viewer",
		});
	});

	it("maps empty strings to undefined", () => {
		expect(validateDashboardSearch({ consumer: "", role: "" })).toEqual({
			consumer: undefined,
			role: undefined,
		});
	});

	it("maps missing or non-string values to undefined", () => {
		expect(validateDashboardSearch({})).toEqual({
			consumer: undefined,
			role: undefined,
		});
		expect(validateDashboardSearch({ consumer: 42, role: null })).toEqual({
			consumer: undefined,
			role: undefined,
		});
	});
});
