/**
 * Dashboard render tests (live derivation: every section renders from
 * `buildDashboardData` over seeded audit decisions, never seeded metrics).
 * Components are rendered headlessly with `renderToStaticMarkup`; assertions
 * target section headings, table cells, and stat labels, which are plain
 * markup. The recharts-based charts render under static markup in bun but are
 * not asserted on. Every expected number, category, reason, and usage string
 * is derived from the built `DashboardData` in the test, so the suite tracks
 * the live derivation instead of pinning fixture values.
 */
import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivitySections } from "#/components/dashboard/activity-sections.tsx";
import { Dashboard } from "#/components/dashboard/dashboard.tsx";
import {
	BudgetSection,
	LatencySection,
	PostureSection,
	ThreatsSection,
} from "#/components/dashboard/metric-sections.tsx";
import { PeopleSection } from "#/components/dashboard/people-sections.tsx";
import { matchesPerson, personLabel, roleLabel } from "#/components/dashboard/persons.ts";
import {
	ControlsSection,
	EscalationsSection,
	ProfilesSection,
} from "#/components/dashboard/policy-sections.tsx";
import { ThemeProvider } from "#/components/theme-provider.tsx";
import { type AuditEvent, auditEvent } from "#/control/audit.ts";
import type { PolicySnapshot } from "#/control/policy/loader.ts";
import type { Policy } from "#/control/policy/schema.ts";
import { parsePolicy } from "#/control/policy/schema.ts";
import type { Direction, Verdict } from "#/control/types.ts";
import { buildDashboardData, selectEscalations, selectMetrics } from "#/dashboard/data.ts";
import {
	formatCount,
	formatMs,
	formatTimestamp,
	formatTokens,
	formatUsd,
	usagePercent,
} from "#/dashboard/format.ts";
import { ALL_CONSUMERS, type ConsumerMetrics, type DashboardData } from "#/dashboard/types.ts";

const TEST_POLICY_VERSION = "sha256.test-render-policy-version";
const GENERATED_AT = "2026-10-04T20:00:00.000Z";

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

type BudgetRules = Policy["controls"]["budget"]["rules"];

function snapshotWithBudget(rules: BudgetRules): PolicySnapshot {
	return {
		policy: {
			...SNAPSHOT.policy,
			controls: {
				...SNAPSHOT.policy.controls,
				budget: { ...SNAPSHOT.policy.controls.budget, rules },
			},
		},
		policyVersion: TEST_POLICY_VERSION,
	};
}

function renderDecision(input: {
	readonly completionTokens?: number;
	readonly controlId?: string;
	readonly costUsd?: number;
	readonly detail?: string;
	readonly direction?: Direction;
	readonly groupId: string;
	readonly hits?: { category: string; controlId: string; kind: string }[];
	readonly interactionId: string;
	readonly latencyMs?: number;
	readonly model?: string;
	readonly promptTokens?: number;
	readonly redactionCount?: number;
	readonly seam?: string;
	readonly timestamp: string;
	readonly userId: string;
	readonly verdict: Verdict;
}): AuditEvent {
	const { timestamp, ...fields } = input;
	return {
		...auditEvent("interaction", { consumerKey: fields.groupId, ...fields }),
		timestamp,
	};
}

const RENDER_BASE_MS = Date.parse("2026-10-04T10:00:00.000Z");
const MINUTE_MS = 60_000;

function renderStamp(offsetMinutes: number): string {
	return new Date(RENDER_BASE_MS + offsetMinutes * MINUTE_MS).toISOString();
}

/** Seeded decisions with distinctive per-consumer counts: hr allows 47,
 * software-developer allows 13, manager allows 2, so posture isolation reads
 * off the rendered stat cards. */
function seedRenderEvents(): readonly AuditEvent[] {
	const events: AuditEvent[] = [];
	for (let index = 0; index < 47; index += 1) {
		events.push(
			renderDecision({
				completionTokens: 20,
				controlId: "detection",
				costUsd: 0.05,
				groupId: "hr",
				hits: [{ category: "live.render.hr", controlId: "detection", kind: "pii" }],
				interactionId: `hr-render-allow-${index}`,
				latencyMs: 25,
				model: "primary",
				promptTokens: 100,
				seam: "guard-api",
				timestamp: renderStamp(index),
				userId: "alice",
				verdict: "allow",
			}),
		);
	}
	for (let index = 0; index < 2; index += 1) {
		events.push(
			renderDecision({
				controlId: "detection",
				groupId: "hr",
				hits: [{ category: "live.render.hr", controlId: "detection", kind: "pii" }],
				interactionId: `hr-render-redact-${index}`,
				latencyMs: 30,
				model: "primary",
				redactionCount: 3,
				seam: "guard-api",
				timestamp: renderStamp(60 + index),
				userId: "alice",
				verdict: "redact",
			}),
		);
	}
	events.push(
		renderDecision({
			controlId: "signatures",
			groupId: "hr",
			hits: [
				{ category: "live.render.hrblock", controlId: "signatures", kind: "prompt_injection" },
			],
			interactionId: "hr-render-block-1",
			latencyMs: 45,
			model: "primary",
			seam: "guard-api",
			timestamp: renderStamp(70),
			userId: "alice",
			verdict: "block",
		}),
		renderDecision({
			controlId: "semantic",
			detail: "hr render queue needs review",
			direction: "outbound",
			groupId: "hr",
			interactionId: "hr-render-esc-1",
			latencyMs: 60,
			model: "primary",
			seam: "chat",
			timestamp: renderStamp(80),
			userId: "alice",
			verdict: "escalate",
		}),
	);
	for (let index = 0; index < 2; index += 1) {
		events.push(
			renderDecision({
				controlId: "pipeline",
				groupId: "manager",
				interactionId: `manager-render-allow-${index}`,
				latencyMs: 35,
				model: "primary",
				seam: "guard-api",
				timestamp: renderStamp(90 + index),
				userId: "bob",
				verdict: "allow",
			}),
		);
	}
	events.push(
		renderDecision({
			controlId: "semantic",
			detail: "manager render queue needs review",
			direction: "inbound",
			groupId: "manager",
			interactionId: "manager-render-esc-1",
			latencyMs: 55,
			model: "primary",
			seam: "guard-api",
			timestamp: renderStamp(100),
			userId: "bob",
			verdict: "escalate",
		}),
	);
	for (let index = 0; index < 13; index += 1) {
		events.push(
			renderDecision({
				controlId: "pipeline",
				groupId: "software-developer",
				interactionId: `dev-render-allow-${index}`,
				latencyMs: 15,
				model: "primary",
				seam: "guard-api",
				timestamp: renderStamp(110 + index),
				userId: "carol",
				verdict: "allow",
			}),
		);
	}
	return events;
}

const RENDER_RULES: BudgetRules = [
	{ key: "hr", modelScope: "*", period: "day", tokens: 50_000 },
	{ costUsd: 20, key: "hr", modelScope: "*", period: "month" },
];

const RENDER_FEED_VERSION = "feed.test.live-render-1";
const RENDER_SEMANTIC_VERSION = "sem.test.live-render-1";

const DATA: DashboardData = buildDashboardData(
	snapshotWithBudget(RENDER_RULES),
	GENERATED_AT,
	seedRenderEvents(),
	{ feedVersion: RENDER_FEED_VERSION, semanticVersion: RENDER_SEMANTIC_VERSION },
);
const ALICE = selectMetrics(DATA, "hr");
const DEPLOY_BOT = selectMetrics(DATA, "software-developer");

function verdictTotal(metrics: ConsumerMetrics): number {
	return (
		metrics.verdicts.allow +
		metrics.verdicts.redact +
		metrics.verdicts.block +
		metrics.verdicts.escalate
	);
}

function formatBudgetValue(metric: string, value: number): string {
	if (metric === "costUsd") {
		return formatUsd(value);
	}
	if (metric === "tokens") {
		return formatTokens(value);
	}
	return formatCount(value);
}

describe("dashboard rendering against live data", () => {
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
			"Cost and tokens",
			"Latency",
			"Controls in force",
			"Strictness profiles",
			"People",
		]) {
			expect(html).toContain(heading);
		}
		expect(html).toContain("Saif security dashboard");
		expect(html).toContain(`policy ${TEST_POLICY_VERSION.slice(0, 12)}`);
		expect(html).toContain(`feed ${DATA.feedVersion}`);
		expect(html).toContain(`jev ${DATA.semanticVersion}`);
		expect(html).toContain("default profile: standard");
		expect(html).toContain("failure verdict: escalate");
	});

	it("reads jev unknown when no semantic version is stamped", () => {
		const unstamped = buildDashboardData(SNAPSHOT, GENERATED_AT, []);
		expect(unstamped.semanticVersion).toBe("unavailable");
		const html = render(
			createElement(
				ThemeProvider,
				null,
				createElement(Dashboard, { initialData: unstamped, onRefresh: async () => unstamped }),
			),
		);
		expect(html).toContain("jev unknown");
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

	it("shows the aggregate posture numbers pooled from live decisions", () => {
		const html = render(createElement(PostureSection, { metrics: DATA.aggregate }));
		const aggregate = DATA.aggregate;
		expect(html).toContain(`>${formatCount(aggregate.verdicts.allow)}<`);
		expect(html).toContain(`>${formatCount(aggregate.verdicts.redact)}<`);
		expect(html).toContain(`>${formatCount(aggregate.verdicts.block)}<`);
		expect(html).toContain(`>${formatCount(aggregate.verdicts.escalate)}<`);
		expect(html).toContain(`${formatCount(aggregate.redactions)} spans redacted`);
	});

	it("isolates one consumer's posture numbers from the others", () => {
		const aliceHtml = render(createElement(PostureSection, { metrics: ALICE }));
		expect(aliceHtml).toContain(`>${formatCount(ALICE.verdicts.allow)}<`);
		expect(aliceHtml).toContain(`${formatCount(ALICE.redactions)} spans redacted`);
		expect(aliceHtml).not.toContain(`>${formatCount(DEPLOY_BOT.verdicts.allow)}<`);

		const deployHtml = render(createElement(PostureSection, { metrics: DEPLOY_BOT }));
		expect(deployHtml).toContain(`>${formatCount(DEPLOY_BOT.verdicts.allow)}<`);
		expect(deployHtml).not.toContain(`>${formatCount(ALICE.verdicts.allow)}<`);
	});

	it("renders the threat table with control and category counts", () => {
		const html = render(createElement(ThreatsSection, { metrics: ALICE }));
		for (const column of ["Control", "Category", "Blocked", "Redacted", "Flagged"]) {
			expect(html).toContain(column);
		}
		for (const row of ALICE.threats) {
			expect(html).toContain(row.category);
			expect(html).toContain(`>${row.blocked}<`);
		}
	});

	it("isolates one consumer's threat rows from the others", () => {
		const html = render(createElement(ThreatsSection, { metrics: ALICE }));
		for (const row of ALICE.threats) {
			expect(html).toContain(row.category);
		}
		const deployHtml = render(createElement(ThreatsSection, { metrics: DEPLOY_BOT }));
		for (const row of ALICE.threats) {
			expect(deployHtml).not.toContain(row.category);
		}
		expect(deployHtml).toContain("No activity in this window");
	});

	it("renders budget rules with usage against limits", () => {
		const html = render(createElement(BudgetSection, { metrics: ALICE }));
		expect(html).toContain("Usage vs limit");
		const rules = ALICE.budget;
		expect(rules.length).toBeGreaterThan(0);
		for (const rule of rules) {
			expect(html).toContain(`per ${rule.period}`);
			expect(html).toContain(formatBudgetValue(rule.metric, rule.used));
			expect(html).toContain(formatBudgetValue(rule.metric, rule.limit));
			expect(html).toContain(`${usagePercent(rule.used, rule.limit)}%`);
		}
	});

	it("renders latency percentile cards", () => {
		const html = render(createElement(LatencySection, { metrics: ALICE }));
		for (const label of ["p50", "p95", "p99"]) {
			expect(html).toContain(label);
		}
		expect(html).toContain(formatMs(ALICE.latency.p50));
		expect(html).toContain(formatMs(ALICE.latency.p95));
		expect(html).toContain(formatMs(ALICE.latency.p99));
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
		const rows = selectEscalations(DATA, ALL_CONSUMERS);
		expect(rows.length).toBeGreaterThan(0);
		const html = render(createElement(EscalationsSection, { rows }));
		for (const row of rows) {
			expect(html).toContain(formatTimestamp(row.timestamp));
			expect(html).toContain(row.seam);
			expect(html).toContain(row.direction);
			expect(html).toContain(row.reason);
		}
	});

	it("isolates one consumer's escalations from the others", () => {
		const hrRows = selectEscalations(DATA, "hr");
		const managerRows = selectEscalations(DATA, "manager");
		expect(hrRows.length).toBeGreaterThan(0);
		expect(managerRows.length).toBeGreaterThan(0);
		const html = render(createElement(EscalationsSection, { rows: hrRows }));
		for (const row of hrRows) {
			expect(html).toContain(row.reason);
		}
		for (const row of managerRows) {
			expect(html).not.toContain(row.reason);
		}
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
		for (const row of ALICE.threats) {
			expect(threatsHtml).not.toContain(row.category);
		}

		const budgetHtml = render(createElement(BudgetSection, { metrics: emptyMetrics }));
		expect(budgetHtml).toContain("No activity in this window");

		const escalationsHtml = render(createElement(EscalationsSection, { rows: [] }));
		expect(escalationsHtml).toContain("No activity in this window");
		for (const row of selectEscalations(DATA, ALL_CONSUMERS)) {
			expect(escalationsHtml).not.toContain(row.reason);
		}
	});
});

const PERSON_ROLES: Readonly<Record<string, string>> = {
	hr: "admin",
	manager: "viewer",
	"software-developer": "viewer",
};

const PEOPLE_DATA: DashboardData = { ...DATA, personRoles: PERSON_ROLES };

function renderDashboard(element: ReactElement): string {
	return render(createElement(ThemeProvider, null, element));
}

describe("dashboard people section", () => {
	it("renders the People heading with search and role controls", () => {
		const html = renderDashboard(
			createElement(Dashboard, { initialData: PEOPLE_DATA, onRefresh: async () => PEOPLE_DATA }),
		);
		expect(html).toContain("People");
		expect(html).toContain("People activity");
		expect(html).toContain('aria-label="Search people"');
		expect(html).toContain('placeholder="Search people"');
		expect(html).toContain('aria-label="Role scope"');
	});

	it("lists people sorted by total desc with consumer links and role labels", () => {
		const html = renderDashboard(
			createElement(Dashboard, { initialData: PEOPLE_DATA, onRefresh: async () => PEOPLE_DATA }),
		);
		for (const column of ["Person", "Role", "Allow", "Redact", "Block", "Escalate", "Total"]) {
			expect(html).toContain(column);
		}
		for (const userId of ["hr", "manager", "software-developer"]) {
			expect(html).toContain(`?consumer=${userId}`);
		}
		expect(html).toContain("Admin");
		expect(html).toContain("Viewer");
		const totals = (["hr", "manager", "software-developer"] as const)
			.map((key) => ({ key, total: verdictTotal(PEOPLE_DATA.byConsumer[key] ?? DATA.aggregate) }))
			.sort((left, right) => right.total - left.total);
		for (const { total } of totals) {
			expect(html).toContain(`>${formatCount(total)}<`);
		}
		const positions = totals.map(({ key }) => html.indexOf(`?consumer=${key}`));
		for (const position of positions) {
			expect(position).toBeGreaterThanOrEqual(0);
		}
		const ordered = [...positions].sort((left, right) => left - right);
		expect(positions).toEqual(ordered);
	});

	it("shows the unknown role when a consumer has no person mapping", () => {
		const html = renderDashboard(
			createElement(Dashboard, { initialData: DATA, onRefresh: async () => DATA }),
		);
		expect(html).toContain("Unknown");
		expect(html).toContain("?consumer=hr");
	});

	it("filters the People table by the initialRole prop", () => {
		const html = renderDashboard(
			createElement(Dashboard, {
				initialData: PEOPLE_DATA,
				initialRole: "viewer",
				onRefresh: async () => PEOPLE_DATA,
			}),
		);
		expect(html).toContain("?consumer=manager");
		expect(html).toContain("?consumer=software-developer");
		expect(html).not.toContain("?consumer=hr");
	});

	it("scopes the escalation queue by role through the consumer mapping", () => {
		const hrReasons = selectEscalations(PEOPLE_DATA, "hr").map((row) => row.reason);
		const otherReasons = selectEscalations(PEOPLE_DATA, ALL_CONSUMERS)
			.filter((row) => row.consumerKey !== "hr")
			.map((row) => row.reason);
		expect(hrReasons.length).toBeGreaterThan(0);
		expect(otherReasons.length).toBeGreaterThan(0);
		const html = renderDashboard(
			createElement(ActivitySections, {
				consumer: undefined,
				data: PEOPLE_DATA,
				role: "admin",
			}),
		);
		for (const reason of hrReasons) {
			expect(html).toContain(reason);
		}
		for (const reason of otherReasons) {
			expect(html).not.toContain(reason);
		}
	});

	it("keeps every escalation without a role filter", () => {
		const html = renderDashboard(
			createElement(ActivitySections, {
				consumer: undefined,
				data: PEOPLE_DATA,
				role: undefined,
			}),
		);
		for (const row of selectEscalations(PEOPLE_DATA, ALL_CONSUMERS)) {
			expect(html).toContain(row.reason);
		}
	});

	it("shows the empty state when the people rows are empty", () => {
		const html = render(createElement(PeopleSection, { rows: [] }));
		expect(html).toContain("No activity in this window");
		expect(html).not.toContain("?consumer=");
	});
});

describe("dashboard person helpers", () => {
	it("labels a person by userId", () => {
		expect(personLabel("hr")).toBe("hr");
		expect(personLabel("software-developer")).toBe("software-developer");
	});

	it("labels a role from its groupId", () => {
		expect(roleLabel("software-developer")).toBe("Software developer");
		expect(roleLabel("hr")).toBe("Hr");
		expect(roleLabel("")).toBe("(none)");
	});

	it("matches people case-insensitively on a substring", () => {
		expect(matchesPerson("hr", undefined)).toBe(true);
		expect(matchesPerson("hr", "")).toBe(true);
		expect(matchesPerson("hr", "   ")).toBe(true);
		expect(matchesPerson("software-developer", "SOFTware")).toBe(true);
		expect(matchesPerson("software-developer", "velop")).toBe(true);
		expect(matchesPerson("hr", "manager")).toBe(false);
	});
});
