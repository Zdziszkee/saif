import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createPolicyStore, loadPolicy } from "#/control/policy/loader.ts";
import {
	isModelAllowed,
	type Policy,
	resolveConsumer,
	resolveProfile,
} from "#/control/policy/schema.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SAMPLES = ["policy.json", "policy.permissive.json", "policy.strict.json"];

function writeTempPolicy(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "saif-policy-"));
	const path = join(dir, "policy.json");
	writeFileSync(path, contents);
	return path;
}

function loadBasePolicy(): Policy {
	const result = loadPolicy(join(REPO_ROOT, "policy.json"));
	if (!result.ok) throw new Error(`fixture policy must load: ${result.errors.join(", ")}`);
	return result.snapshot.policy;
}

describe("loadPolicy", () => {
	it("loads a valid policy with a content-hash version", () => {
		const result = loadPolicy(join(REPO_ROOT, "policy.json"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.snapshot.version).toMatch(/^[0-9a-f]{16}$/);
		expect(result.snapshot.policy.defaultProfile).toBe("standard");
	});

	it.each(SAMPLES)("sample %s is valid against the schema", (file) => {
		const result = loadPolicy(join(REPO_ROOT, file));
		expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
	});

	it("reports errors for a missing file without throwing", () => {
		const result = loadPolicy("/nonexistent/policy.json");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors[0]).toContain("cannot read policy file");
	});

	it("reports errors for invalid JSON without throwing", () => {
		const result = loadPolicy(writeTempPolicy("{ not json"));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors[0]).toContain("invalid JSON");
	});

	it("reports field paths for schema violations", () => {
		const policy = loadBasePolicy() as unknown as Record<string, unknown>;
		const controls = policy["controls"] as Record<string, unknown>;
		const deterministic = controls["deterministic"] as Record<string, unknown>;
		const actions = deterministic["actions"] as Record<string, unknown>;
		actions["secret"] = "obliterate"; // not a valid verdict
		const result = loadPolicy(writeTempPolicy(JSON.stringify(policy)));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors.join("\n")).toContain("controls.deterministic.actions.secret");
	});

	it("rejects a policy with no allowed models", () => {
		const policy = loadBasePolicy() as unknown as Record<string, unknown>;
		policy["allowlist"] = { models: [] };
		const result = loadPolicy(writeTempPolicy(JSON.stringify(policy)));
		expect(result.ok).toBe(false);
	});
});

describe("policy store", () => {
	it("keeps the last valid policy active when a reload fails", () => {
		const path = writeTempPolicy(JSON.stringify(loadBasePolicy()));
		const store = createPolicyStore(path);

		expect(store.get()).toBeNull();
		expect(store.reload().ok).toBe(true);
		const first = store.get();
		expect(first).not.toBeNull();

		writeFileSync(path, "{ broken");
		const second = store.reload();
		expect(second.ok).toBe(false);
		expect(store.get()).toBe(first);
		expect(store.getErrors().length).toBeGreaterThan(0);

		writeFileSync(path, JSON.stringify({ ...loadBasePolicy(), version: 2 }));
		expect(store.reload().ok).toBe(true);
		expect(store.getErrors()).toEqual([]);
		expect(store.get()?.policy.version).toBe(2);
		expect(store.get()?.version).not.toBe(first?.version);
	});
});

describe("profile resolution", () => {
	const policy = loadBasePolicy();

	it("resolves the standard profile from base controls", () => {
		const { controls } = resolveProfile(policy, "standard");
		expect(controls.semantic.questions.promptInjection?.blockThreshold).toBe(0.85);
		expect(controls.deterministic.actions.secret).toBe("block");
	});

	it("applies strict overrides without mutating the base", () => {
		const strict = resolveProfile(policy, "strict");
		const base = resolveProfile(policy, "standard");
		expect(strict.controls.semantic.questions.promptInjection?.blockThreshold).toBe(0.6);
		expect(base.controls.semantic.questions.promptInjection?.blockThreshold).toBe(0.85);
		expect(strict.controls.deterministic.actions.pii).toBe("block");
		expect(base.controls.deterministic.actions.pii).toBe("redact");
	});

	it("applies permissive overrides including failure verdict", () => {
		const permissive = resolveProfile(policy, "permissive");
		expect(permissive.failureVerdict).toBe("escalate");
		expect(permissive.controls.semantic.questions.jailbreak?.blockThreshold).toBe(0.95);
		expect(permissive.controls.deterministic.actions.pii).toBe("allow");
	});

	it("falls back to defaults for unknown consumers", () => {
		const resolved = resolveConsumer(policy, "unknown-key");
		expect(resolved.profile).toBe("standard");
		expect(resolved.budgetGroup).toBe("default");
	});

	it("resolves declared consumers to their profile and budget group", () => {
		const resolved = resolveConsumer(policy, "trusted-internal");
		expect(resolved.profile).toBe("permissive");
		expect(resolved.budgetGroup).toBe("default");
	});
});

describe("model allowlist", () => {
	const policy = loadBasePolicy();

	it("allows any model when the list contains the wildcard", () => {
		expect(isModelAllowed(policy, "some-model")).toBe(true);
	});

	it("rejects models outside an explicit list", () => {
		const restricted: Policy = {
			...policy,
			allowlist: { models: ["ollama/llama3.2"] },
		};
		expect(isModelAllowed(restricted, "ollama/llama3.2")).toBe(true);
		expect(isModelAllowed(restricted, "gpt-9")).toBe(false);
	});
});
