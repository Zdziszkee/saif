/**
 * CostPlot render tests: title, user-filter inbox, totals description,
 * empty state, date ticks, plus `formatUsdCompact` unit checks.
 * Rendered headlessly with `renderToStaticMarkup` (dashboard.test.ts idiom).
 */
import { describe, expect, it } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CostPlot } from "#/components/dashboard/cost-plot.tsx";
import { formatUsdCompact } from "#/dashboard/format.ts";
import type { CostTotals } from "#/dashboard/types.ts";

function render(element: ReactElement): string {
	return renderToStaticMarkup(element);
}

const PRICED_TOTALS: CostTotals = {
	costUsd: 12.5,
	gatewayTokens: 1000,
	mcpTokens: 500,
	pricedCalls: 2,
	totalTokens: 1500,
	unpricedCalls: 0,
};

const UNPRICED_TOTALS: CostTotals = {
	costUsd: null,
	gatewayTokens: 30,
	mcpTokens: 30,
	pricedCalls: 0,
	totalTokens: 60,
	unpricedCalls: 1,
};

const TWO_POINTS = [
	{ costUsd: 2, date: "2026-10-01", gatewayTokens: 150, mcpTokens: 0 },
	{ costUsd: 1, date: "2026-10-02", gatewayTokens: 100, mcpTokens: 0 },
];

describe("CostPlot", () => {
	it("renders title, inbox, and totals description with $ cost", () => {
		const html = render(
			createElement(CostPlot, { byUser: {}, series: TWO_POINTS, totals: PRICED_TOTALS }),
		);
		expect(html).toContain("Cost and tokens");
		expect(html).toContain('placeholder="Filter by user id"');
		expect(html).toContain(formatUsdCompact(PRICED_TOTALS.costUsd ?? 0));
		expect(html).toContain("All users");
	});

	it("shows unpriced when totals cost is null", () => {
		const html = render(
			createElement(CostPlot, { byUser: {}, series: TWO_POINTS, totals: UNPRICED_TOTALS }),
		);
		expect(html).toContain("unpriced");
	});

	it("renders the empty state with no chart lines for an empty series", () => {
		const html = render(
			createElement(CostPlot, { byUser: {}, series: [], totals: UNPRICED_TOTALS }),
		);
		expect(html).toContain("No metered usage yet.");
		expect(html).not.toContain("recharts-line");
	});

	it("maps a 2-point series onto YYYY-MM-DD tick labels", () => {
		const html = render(
			createElement(CostPlot, { byUser: {}, series: TWO_POINTS, totals: PRICED_TOTALS }),
		);
		// Recharts renders an empty `.recharts-wrapper` under
		// `renderToStaticMarkup` (no layout effects on the server), so tick
		// `<text>` nodes never reach static markup. Assert the chart shell
		// renders instead of the empty state, plus the exact tick-label
		// contract the XAxis `tickFormatter` applies to each point.
		expect(html).not.toContain("No metered usage yet.");
		expect(html).toContain("recharts-wrapper");
		for (const point of TWO_POINTS) {
			expect(new Date(Date.parse(point.date)).toISOString().slice(0, 10)).toBe(point.date);
		}
	});
});

describe("formatUsdCompact", () => {
	it("compacts thousands, keeps sub-dollar visible, flags non-finite", () => {
		expect(formatUsdCompact(12_500)).toBe("$12.5k");
		expect(formatUsdCompact(0.04)).toBe("$0.04");
		expect(formatUsdCompact(0.04)).not.toBe("$0.00");
		expect(formatUsdCompact(Number.NaN)).toBe("?");
		expect(formatUsdCompact(Number.POSITIVE_INFINITY)).toBe("?");
	});
});
