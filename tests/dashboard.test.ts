/**
 * Dashboard render tests (saif 11.1 verify line: "component renders expected
 * sections against fixture data"). Components are rendered headlessly with
 * `renderToStaticMarkup`; assertions target section headings, table cells, and
 * stat labels, which are plain markup. The recharts-based charts render under
 * static markup in bun but are not asserted on.
 */
import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Dashboard } from "#/components/dashboard/dashboard.tsx";
import {
	BudgetSection,
	LatencySection,
	PostureSection,
	ThreatsSection,
} from "#/components/dashboard/metric-sections.tsx";
import {
	ControlsSection,
	EscalationsSection,
	ProfilesSection,
} from "#/components/dashboard/policy-sections.tsx";
import { ThemeProvider } from "#/components/theme-provider.tsx";
import type { PolicySnapshot } from "#/control/policy/loader.ts";
import { parsePolicy } from "#/control/policy/schema.ts";
import { buildDashboardData, selectEscalations, selectMetrics } from "#/dashboard/data.ts";
import { FIXTURE_FEED_VERSION } from "#/dashboard/fixture.ts";
import { ALL_CONSUMERS, type ConsumerMetrics, type DashboardData } from "#/dashboard/types.ts";

const TEST_POLICY_VERSION = "sha256.test-render-policy-version";
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

function render(element: ReactElement): string {
	return renderToStaticMarkup(element);
}

const SNAPSHOT = await loadSnapshot();
const DATA: DashboardData = buildDashboardData(SNAPSHOT, GENERATED_AT);
const ALICE = selectMetrics(DATA, "hr");
const DEPLOY_BOT = selectMetrics(DATA, "software-developer");

describe("dashboard rendering against fixture data", () => {
	it("renders every section heading and the version badges", () => {
		const html = render(
			createElement(
				ThemeProvider,
				null,
				createElement(Dashboard, { initialData: DATA, onRefresh: async () => DATA }),
			),
		);
		for (const heading of [
			"Security posture",
			"Threat breakdown",
			"Budget usage",
			"Latency",
			"Controls in force",
			"Strictness profiles",
			"Escalation queue",
		]) {
			expect(html).toContain(heading);
		}
		expect(html).toContain("Saif security dashboard");
		expect(html).toContain(`policy ${TEST_POLICY_VERSION.slice(0, 12)}`);
		expect(html).toContain(`feed ${FIXTURE_FEED_VERSION}`);
		expect(html).toContain("default profile: standard");
		expect(html).toContain("failure verdict: escalate");
	});

	it("labels all four verdicts in the posture section", () => {
		const html = render(createElement(PostureSection, { metrics: DATA.aggregate }));
		for (const label of ["Allow", "Redact", "Block", "Escalate"]) {
			expect(html).toContain(label);
		}
		for (const verdict of ["allow", "redact", "block", "escalate"]) {
			expect(html.toLowerCase()).toContain(verdict);
		}
	});

	it("shows the aggregate posture numbers across consumers", () => {
		const html = render(createElement(PostureSection, { metrics: DATA.aggregate }));
		expect(html).toContain(">4,270<");
		expect(html).toContain(">157<");
		expect(html).toContain(">85<");
		expect(html).toContain(">13<");
		expect(html).toContain("157 spans redacted");
	});

	it("isolates one consumer's posture numbers from the others", () => {
		const aliceHtml = render(createElement(PostureSection, { metrics: ALICE }));
		expect(aliceHtml).toContain(">1,180<");
		expect(aliceHtml).toContain(">42<");
		expect(aliceHtml).toContain("42 spans redacted");
		expect(aliceHtml).not.toContain(">640<");
		expect(aliceHtml).not.toContain("2,450");

		const deployHtml = render(createElement(PostureSection, { metrics: DEPLOY_BOT }));
		expect(deployHtml).toContain(">2,450<");
		expect(deployHtml).not.toContain("1,180");
	});

	it("renders the threat table with control and category counts", () => {
		const html = render(createElement(ThreatsSection, { metrics: ALICE }));
		for (const column of ["Control", "Category", "Blocked", "Redacted", "Flagged"]) {
			expect(html).toContain(column);
		}
		for (const category of ["pii.email", "secret.api_key", "prompt_injection", "jailbreak"]) {
			expect(html).toContain(category);
		}
		expect(html).toContain(">19<");
	});

	it("isolates one consumer's threat rows from the others", () => {
		const html = render(createElement(ThreatsSection, { metrics: ALICE }));
		for (const otherCategory of [
			"pii.card",
			"data_exfiltration",
			"malicious_code",
			"supply_chain",
		]) {
			expect(html).not.toContain(otherCategory);
		}
		const deployHtml = render(createElement(ThreatsSection, { metrics: DEPLOY_BOT }));
		expect(deployHtml).toContain("supply_chain");
		expect(deployHtml).not.toContain("data_exfiltration");
	});

	it("renders budget rules with usage against limits", () => {
		const html = render(createElement(BudgetSection, { metrics: ALICE }));
		expect(html).toContain("Usage vs limit");
		expect(html).toContain("per day");
		expect(html).toContain("per month");
		expect(html).toContain(">148.2k<");
		expect(html).toContain(">250.0k<");
		expect(html).toContain("$11.40");
		expect(html).toContain("$20.00");
		expect(html).toContain("59%");
		expect(html).toContain("57%");
	});

	it("renders latency percentile cards", () => {
		const html = render(createElement(LatencySection, { metrics: ALICE }));
		for (const label of ["p50", "p95", "p99"]) {
			expect(html).toContain(label);
		}
		expect(html).toContain("38 ms");
		expect(html).toContain("121 ms");
		expect(html).toContain("260 ms");
		expect(html).toContain("median pipeline latency");
	});

	it("renders the controls in force table from the policy view", () => {
		const html = render(createElement(ControlsSection, { controls: DATA.policy.controls }));
		for (const controlId of [
			"shape",
			"allowlist",
			"detection",
			"redaction",
			"semantic",
			"signatures",
			"budget",
		]) {
			expect(html).toContain(controlId);
		}
		expect(html).toContain("active");
		expect(html).toContain("payloads up to");
	});

	it("renders the strictness profiles table from the policy view", () => {
		const html = render(createElement(ProfilesSection, { profiles: DATA.policy.profiles }));
		for (const profile of ["permissive", "standard", "strict"]) {
			expect(html).toContain(profile);
		}
		expect(html).toContain("Detection block");
		expect(html).toContain("Signatures block");
		expect(html).toContain(">0.95<");
		expect(html).toContain(">0.85<");
	});

	it("renders the escalation queue rows", () => {
		const html = render(
			createElement(EscalationsSection, { rows: selectEscalations(DATA, ALL_CONSUMERS) }),
		);
		expect(html).toContain("2026-10-03 18:42:11Z");
		expect(html).toContain("2026-10-03 17:05:47Z");
		for (const seam of ["mcp-tool", "guard-api", "chat"]) {
			expect(html).toContain(seam);
		}
		expect(html).toContain("outbound");
		expect(html).toContain("inbound");
		expect(html).toContain("semantic decisiveness below floor (data_exfiltration p=0.58)");
	});

	it("isolates one consumer's escalations from the others", () => {
		const html = render(
			createElement(EscalationsSection, { rows: selectEscalations(DATA, "software-developer") }),
		);
		expect(html).toContain("mcp-tool");
		expect(html).toContain("guard-api");
		expect(html).not.toContain("signature suspect signals above threshold");
		expect(html).not.toContain("residual sensitive span in egress state");
	});

	it("shows the 'No activity in this window' empty state when a section's rows are empty", () => {
		const emptyMetrics: ConsumerMetrics = {
			...ALICE,
			budget: [],
			budgetSeries: [],
			threats: [],
		};
		const threatsHtml = render(createElement(ThreatsSection, { metrics: emptyMetrics }));
		expect(threatsHtml).toContain("No activity in this window");
		expect(threatsHtml).not.toContain("prompt_injection");

		const budgetHtml = render(createElement(BudgetSection, { metrics: emptyMetrics }));
		expect(budgetHtml).toContain("No activity in this window");
		expect(budgetHtml).not.toContain("148.2k");

		const escalationsHtml = render(createElement(EscalationsSection, { rows: [] }));
		expect(escalationsHtml).toContain("No activity in this window");
		expect(escalationsHtml).not.toContain("mcp-tool");
	});
});
