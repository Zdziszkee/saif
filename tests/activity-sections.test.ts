/**
 * ActivitySections render tests: the scope banner, the by-consumer links, and
 * the empty states. Components are rendered headlessly with
 * `renderToStaticMarkup` wrapped in the `ThemeProvider`, mirroring
 * `tests/dashboard.test.ts`.
 */
import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivitySections } from "#/components/dashboard/activity-sections.tsx";
import { ThemeProvider } from "#/components/theme-provider.tsx";
import type { PolicySnapshot } from "#/control/policy/loader.ts";
import { parsePolicy } from "#/control/policy/schema.ts";
import { buildDashboardData } from "#/dashboard/data.ts";
import type { DashboardData } from "#/dashboard/types.ts";

const TEST_POLICY_VERSION = "sha256.test-activity-sections-policy-version";
const GENERATED_AT = "2026-10-03T20:00:00.000Z";

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

function renderActivity(element: ReactElement): string {
	return renderToStaticMarkup(createElement(ThemeProvider, null, element));
}

const SNAPSHOT = await loadSnapshot();
const DATA: DashboardData = buildDashboardData(SNAPSHOT, GENERATED_AT);

const PERSON_ROLES: Readonly<Record<string, string>> = {
	hr: "admin",
	manager: "viewer",
	"software-developer": "viewer",
};

const PEOPLE_DATA: DashboardData = { ...DATA, personRoles: PERSON_ROLES };

describe("activity sections", () => {
	it("renders the Activity heading with unscoped by-consumer and escalations titles", () => {
		const html = renderActivity(
			createElement(ActivitySections, { consumer: undefined, data: DATA, role: undefined }),
		);
		expect(html).toContain("Activity");
		expect(html).toContain("By consumer key");
		expect(html).toContain("Escalations with consumer attribution");
		expect(html).not.toContain("Showing consumer scope");
		expect(html).not.toContain("Showing role scope");
	});

	it("shows the consumer scope banner with a Clear link back to the overview", () => {
		const html = renderActivity(
			createElement(ActivitySections, { consumer: "hr", data: PEOPLE_DATA, role: undefined }),
		);
		expect(html).toContain("Showing consumer scope: hr");
		expect(html).toContain('href="/"');
		expect(html).toContain("Escalations for hr");
	});

	it("preserves the other scope filter in each banner Clear link", () => {
		const html = renderActivity(
			createElement(ActivitySections, { consumer: "hr", data: PEOPLE_DATA, role: "admin" }),
		);
		expect(html).toContain("Showing consumer scope: hr");
		expect(html).toContain("Showing role scope: admin");
		expect(html).toContain("/?role=admin");
		expect(html).toContain("/?consumer=hr");
	});

	it("links consumers to the overview query instead of the legacy dashboard route", () => {
		const html = renderActivity(
			createElement(ActivitySections, {
				consumer: undefined,
				data: PEOPLE_DATA,
				role: undefined,
			}),
		);
		expect(html).toContain("/?consumer=");
		expect(html).toContain("/?consumer=hr");
		expect(html).not.toContain("/dashboard");
	});

	it("appends the role filter to consumer links when a role is set", () => {
		const html = renderActivity(
			createElement(ActivitySections, {
				consumer: undefined,
				data: PEOPLE_DATA,
				role: "admin",
			}),
		);
		expect(html).toContain("/?consumer=");
		expect(html).toContain("role=admin");
		expect(html).not.toContain("/dashboard");
	});

	it("shows the empty state when there is no activity in the window", () => {
		const empty: DashboardData = { ...DATA, byConsumer: {}, escalations: [] };
		const html = renderActivity(
			createElement(ActivitySections, { consumer: undefined, data: empty, role: undefined }),
		);
		expect(html).toContain("No activity in this window");
		expect(html).not.toContain("/?consumer=");
	});
});
