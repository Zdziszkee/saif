/**
 * JEV UI visibility: the semantic tier stays visible in the UI even with no
 * TYPESAFE_API_KEY (mock or omitted, never a silent fail-open dead-end).
 * Hermetic: static markup over pure components plus the pure policy
 * projection — no network, no keys, no timers.
 */
import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EditorTabs } from "#/components/controls/controls-view.tsx";
import { type TierStatus, TierStatusBannerContent } from "#/components/tier-status.tsx";
import type { PolicySnapshot } from "#/control/policy/loader.ts";
import type { Policy } from "#/control/policy/schema.ts";
import { parsePolicy } from "#/control/policy/schema.ts";
import { SEMANTIC_DEFAULTS, type SemanticConfig } from "#/control/semantic/config.ts";
import { summarizePolicy } from "#/dashboard/policy-view.ts";

const TEST_POLICY_VERSION = "sha256.test-jev-ui-visibility";
const TEST_FEED_VERSION = "feed.test.jev-ui-1";
const TEST_SEMANTIC_VERSION = "sem.test.jev-ui-1";

async function loadSnapshot(): Promise<PolicySnapshot> {
	const text = await readFile(new URL("../policy.json", import.meta.url), "utf8");
	const document: unknown = JSON.parse(text);
	const parsed = parsePolicy(document);
	if (!parsed.success) {
		throw new Error(
			`policy.json failed validation: ${parsed.issues.map((issue) => issue.message).join("; ")}`,
		);
	}
	return { policy: parsed.policy, policyVersion: TEST_POLICY_VERSION };
}

const SNAPSHOT = await loadSnapshot();

function statusOf(semantic: TierStatus["semantic"]): TierStatus {
	return {
		feed: { ok: true, version: TEST_FEED_VERSION },
		policy: { profile: "standard", version: TEST_POLICY_VERSION },
		semantic,
	};
}

const seenPolicies: Policy[] = [];
const seenJev: SemanticConfig[] = [];

function handleDraftChange(next: Policy): void {
	seenPolicies.push(next);
}

function handleJevChange(next: SemanticConfig): void {
	seenJev.push(next);
}

describe("tier banner states", () => {
	it("renders the mock badge with heuristic copy when the mock tier is enabled", () => {
		const html = renderToStaticMarkup(
			createElement(TierStatusBannerContent, {
				status: statusOf({ enabled: true, mode: "mock", reason: "mock" }),
			}),
		);
		expect(html).toContain("JEV mock tier");
		expect(html).toContain("mock-jev");
		expect(html).toContain("Regex + signature feed");
		expect(html).not.toContain("tier off");
	});

	it("renders the off badge with the disabled reason when the tier is skipped", () => {
		const reason = "semantic tier disabled: no usable TypeSafe API key";
		const html = renderToStaticMarkup(
			createElement(TierStatusBannerContent, {
				status: statusOf({ enabled: false, mode: "off", reason }),
			}),
		);
		expect(html).toContain("JEV semantic tier off");
		expect(html).toContain(reason);
		expect(html).not.toContain("JEV mock tier");
	});

	it("renders nothing when the live tier is enabled", () => {
		const html = renderToStaticMarkup(
			createElement(TierStatusBannerContent, {
				status: statusOf({ enabled: true, mode: "live" }),
			}),
		);
		expect(html).toBe("");
	});

	it("renders nothing for enabled tiers without a mode stamp (back-compat)", () => {
		const html = renderToStaticMarkup(
			createElement(TierStatusBannerContent, { status: statusOf({ enabled: true }) }),
		);
		expect(html).toBe("");
	});

	it("renders nothing while the status is still loading", () => {
		expect(renderToStaticMarkup(createElement(TierStatusBannerContent, { status: null }))).toBe("");
	});
});

describe("controls JEV tab never dead-ends", () => {
	it("renders the check catalog when the JEV document loaded", () => {
		const html = renderToStaticMarkup(
			createElement(EditorTabs, {
				defaultTab: "jev",
				draft: SNAPSHOT.policy,
				jevDraft: SEMANTIC_DEFAULTS,
				onDraftChange: handleDraftChange,
				onJevChange: handleJevChange,
			}),
		);
		expect(html).toContain("JEV decision-model checks");
		expect(html).toContain("prompt_injection");
		expect(html).not.toContain("JEV checks unavailable");
	});

	it("falls back to the shipped catalog when the tier is off or still loading", () => {
		const html = renderToStaticMarkup(
			createElement(EditorTabs, {
				defaultTab: "jev",
				draft: SNAPSHOT.policy,
				onDraftChange: handleDraftChange,
			}),
		);
		expect(html).toContain("JEV decision-model checks");
		expect(html).toContain("prompt_injection");
		expect(html).not.toContain("JEV checks unavailable");
	});
});

describe("dashboard semantic row reflects live count + mode", () => {
	it("suffixes the mock mode onto the live check count", () => {
		const count = SEMANTIC_DEFAULTS.checks.length;
		const result = summarizePolicy(SNAPSHOT, TEST_FEED_VERSION, TEST_SEMANTIC_VERSION, {
			count,
			mode: "mock",
		});
		const row = result.policy.controls.find((control) => control.id === "semantic");
		expect(row?.detail).toBe(`${count} semantic checks (policy.jev.json) — mock`);
		expect(row?.enabled).toBe(true);
	});

	it("suffixes the live mode onto the live check count", () => {
		const count = SEMANTIC_DEFAULTS.checks.length;
		const result = summarizePolicy(SNAPSHOT, TEST_FEED_VERSION, TEST_SEMANTIC_VERSION, {
			count,
			mode: "live",
		});
		const row = result.policy.controls.find((control) => control.id === "semantic");
		expect(row?.detail).toBe(`${count} semantic checks (policy.jev.json) — live`);
	});

	it("keeps the legacy detail when no live summary is supplied", () => {
		const result = summarizePolicy(SNAPSHOT, TEST_FEED_VERSION);
		const row = result.policy.controls.find((control) => control.id === "semantic");
		expect(row?.detail).toBe(
			`${SEMANTIC_DEFAULTS.checks.length} semantic checks (policy.jev.json)`,
		);
	});
});
