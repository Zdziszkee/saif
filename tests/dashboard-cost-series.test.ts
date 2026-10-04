/**
 * Cost/token series tests: `summarizeCostSeries` buckets gateway + MCP rows
 * per UTC day, and `buildDashboardData` wires the optional MCP rows through
 * to `costSeries`/`costTotals` (empty by default).
 */
import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import type { PolicySnapshot } from "#/control/policy/loader.ts";
import { parsePolicy } from "#/control/policy/schema.ts";
import {
	buildDashboardData,
	type CostGatewayRow,
	type CostMcpRow,
	summarizeCostSeries,
	type TokenUsageRow,
} from "#/dashboard/data.ts";

const TEST_POLICY_VERSION = "sha256.test-cost-series-version";
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

const SNAPSHOT = await loadSnapshot();

function gatewayRow(row: Partial<Omit<CostGatewayRow, "ts">>, ts: unknown): CostGatewayRow {
	return {
		completionTokens: row.completionTokens,
		costUsd: row.costUsd,
		promptTokens: row.promptTokens,
		ts,
	};
}

function mcpRow(estimatedTokens: unknown, ts: unknown): CostMcpRow {
	return { estimatedTokens, ts };
}

function usageRowWithTs(row: TokenUsageRow, ts: string): TokenUsageRow {
	return { ...row, ts } as TokenUsageRow;
}

describe("summarizeCostSeries", () => {
	it("buckets gateway rows across UTC days", () => {
		const { series, totals } = summarizeCostSeries(
			[
				gatewayRow(
					{ completionTokens: 50, costUsd: 2, promptTokens: 100 },
					"2026-10-01T10:00:00.000Z",
				),
				gatewayRow(
					{ completionTokens: 25, costUsd: 1, promptTokens: 75 },
					"2026-10-02T23:00:00.000Z",
				),
				// 23:30 UTC on the 2nd stays on the 2nd; 00:30 UTC flips the day.
				gatewayRow(
					{ completionTokens: 10, costUsd: 0.5, promptTokens: 10 },
					"2026-10-03T00:30:00.000Z",
				),
			],
			[],
		);
		expect(series.map((point) => point.date)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
		expect(series[0]).toMatchObject({ costUsd: 2, gatewayTokens: 150, mcpTokens: 0 });
		expect(series[1]).toMatchObject({ costUsd: 1, gatewayTokens: 100, mcpTokens: 0 });
		expect(totals).toMatchObject({
			costUsd: 3.5,
			gatewayTokens: 270,
			mcpTokens: 0,
			pricedCalls: 3,
			totalTokens: 270,
			unpricedCalls: 0,
		});
	});

	it("merges gateway and MCP tokens into one day without fabricating cost", () => {
		const { series, totals } = summarizeCostSeries(
			[
				gatewayRow(
					{ completionTokens: 40, costUsd: 4, promptTokens: 60 },
					Math.floor(Date.UTC(2026, 9, 1, 12) / 1000),
				),
			],
			[mcpRow(500, new Date("2026-10-01T18:00:00.000Z"))],
		);
		expect(series).toHaveLength(1);
		expect(series[0]).toMatchObject({
			costUsd: 4,
			date: "2026-10-01",
			gatewayTokens: 100,
			mcpTokens: 500,
		});
		expect(totals).toMatchObject({
			costUsd: 4,
			gatewayTokens: 100,
			mcpTokens: 500,
			pricedCalls: 1,
			totalTokens: 600,
			unpricedCalls: 0,
		});
	});

	it("reports null cost when every call is unpriced", () => {
		const { series, totals } = summarizeCostSeries(
			[
				gatewayRow(
					{ completionTokens: 10, costUsd: null, promptTokens: 20 },
					"2026-10-01T10:00:00.000Z",
				),
			],
			[mcpRow(30, "2026-10-01T11:00:00.000Z")],
		);
		expect(series).toHaveLength(1);
		expect(series[0]).toMatchObject({ costUsd: 0, gatewayTokens: 30, mcpTokens: 30 });
		expect(totals.costUsd).toBeNull();
		expect(totals).toMatchObject({ pricedCalls: 0, totalTokens: 60, unpricedCalls: 1 });
	});

	it("counts mixed priced and unpriced calls", () => {
		const { totals } = summarizeCostSeries(
			[
				gatewayRow(
					{ completionTokens: 1, costUsd: 1.5, promptTokens: 1 },
					"2026-10-01T10:00:00.000Z",
				),
				gatewayRow(
					{ completionTokens: 1, costUsd: Number.NaN, promptTokens: 1 },
					"2026-10-01T11:00:00.000Z",
				),
				gatewayRow({ completionTokens: 1, promptTokens: 1 }, "2026-10-01T12:00:00.000Z"),
			],
			[],
		);
		expect(totals).toMatchObject({ costUsd: 1.5, pricedCalls: 1, unpricedCalls: 2 });
	});

	it("skips rows with unparseable timestamps", () => {
		const { series, totals } = summarizeCostSeries(
			[
				gatewayRow({ completionTokens: 100, costUsd: 9, promptTokens: 100 }, "not-a-date"),
				gatewayRow(
					{ completionTokens: 5, costUsd: 1, promptTokens: 5 },
					"2026-10-01T10:00:00.000Z",
				),
			],
			[mcpRow(700, Number.NaN), mcpRow(undefined, undefined)],
		);
		expect(series).toHaveLength(1);
		expect(series[0]).toMatchObject({ date: "2026-10-01", gatewayTokens: 10, mcpTokens: 0 });
		expect(totals).toMatchObject({
			costUsd: 1,
			gatewayTokens: 10,
			mcpTokens: 0,
			pricedCalls: 1,
			totalTokens: 10,
			unpricedCalls: 0,
		});
	});

	it("returns an empty series and zero totals when nothing parses", () => {
		const { series, totals } = summarizeCostSeries([], []);
		expect(series).toEqual([]);
		expect(totals).toEqual({
			costUsd: null,
			gatewayTokens: 0,
			mcpTokens: 0,
			pricedCalls: 0,
			totalTokens: 0,
			unpricedCalls: 0,
		});
	});
});

describe("buildDashboardData cost wiring", () => {
	it("leaves the cost series empty by default", () => {
		const data = buildDashboardData(SNAPSHOT, GENERATED_AT);
		expect(data.costSeries).toEqual([]);
		expect(data.costTotals).toEqual({
			costUsd: null,
			gatewayTokens: 0,
			mcpTokens: 0,
			pricedCalls: 0,
			totalTokens: 0,
			unpricedCalls: 0,
		});
	});

	it("projects gateway ts rows and the 6th MCP param into the series", () => {
		const usageRows: TokenUsageRow[] = [
			usageRowWithTs(
				{ completionTokens: 40, costUsd: 4, model: "gpt", promptTokens: 60, userId: "ana" },
				"2026-10-01T10:00:00.000Z",
			),
		];
		const data = buildDashboardData(SNAPSHOT, GENERATED_AT, [], {}, usageRows, [
			{ estimatedTokens: 500, ts: "2026-10-01T18:00:00.000Z" },
		]);
		expect(data.costSeries).toHaveLength(1);
		expect(data.costSeries[0]).toMatchObject({
			costUsd: 4,
			date: "2026-10-01",
			gatewayTokens: 100,
			mcpTokens: 500,
		});
		expect(data.costTotals).toMatchObject({
			costUsd: 4,
			gatewayTokens: 100,
			mcpTokens: 500,
			pricedCalls: 1,
			totalTokens: 600,
			unpricedCalls: 0,
		});
		// Per-user aggregation still works from the same rows.
		expect(data.userTokenUsage).toHaveLength(1);
	});
});
