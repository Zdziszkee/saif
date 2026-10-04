import { useId, useMemo, useState } from "react";
import { Area, Bar, CartesianGrid, ComposedChart, XAxis, YAxis } from "recharts";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "#/components/ui/card.tsx";
import {
	type ChartConfig,
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
} from "#/components/ui/chart.tsx";
import { formatTokens, formatUsd } from "#/dashboard/format.ts";
import type { CostSeriesPoint, CostTotals, CostUserSeries } from "#/dashboard/types.ts";

const CHART_HEIGHT_CLASS = "h-[220px]";
const BAR_CORNER_RADIUS = 4;
const BAR_RADIUS: [number, number, number, number] = [BAR_CORNER_RADIUS, BAR_CORNER_RADIUS, 0, 0];
const AREA_FILL_OPACITY = 0.3;
const COST_AXIS_ID = "cost";
const TOKEN_AXIS_ID = "tokens";

const COST_CONFIG: ChartConfig = {
	costUsd: { color: "var(--chart-1)", label: "Cost (USD)" },
	gatewayTokens: { color: "var(--chart-2)", label: "Gateway tokens" },
	mcpTokens: { color: "var(--chart-3)", label: "MCP tokens" },
};

const EMPTY_TOTALS: CostTotals = {
	costUsd: null,
	gatewayTokens: 0,
	mcpTokens: 0,
	pricedCalls: 0,
	totalTokens: 0,
	unpricedCalls: 0,
};

interface CostScope {
	hint: string;
	series: readonly CostSeriesPoint[];
	totals: CostTotals;
}

function resolveScope(
	query: string,
	series: readonly CostSeriesPoint[],
	totals: CostTotals,
	byUser: Readonly<Record<string, CostUserSeries>>,
): CostScope {
	const trimmed = query.trim();
	if (trimmed === "") {
		return { hint: "All users", series, totals };
	}
	const selected = byUser[trimmed];
	if (selected === undefined) {
		return { hint: `No usage for "${trimmed}"`, series: [], totals: EMPTY_TOTALS };
	}
	return { hint: `Showing ${trimmed}`, series: selected.series, totals: selected.totals };
}

/** Daily metered spend: stacked gateway/MCP token bars plus a cost area.
 * The inbox filters the plot to one user id; empty shows everyone. */
export function CostPlot({
	byUser,
	series,
	totals,
}: {
	byUser: Readonly<Record<string, CostUserSeries>>;
	series: readonly CostSeriesPoint[];
	totals: CostTotals;
}) {
	const [query, setQuery] = useState("");
	const listId = useId();
	const users = useMemo(() => Object.keys(byUser).sort(), [byUser]);
	const scope = resolveScope(query, series, totals, byUser);
	const shownSeries = scope.series;
	const shownTotals = scope.totals;
	const costLabel = shownTotals.costUsd === null ? "unpriced" : formatUsd(shownTotals.costUsd);
	return (
		<Card>
			<CardHeader>
				<CardTitle>Cost and tokens</CardTitle>
				<CardDescription>
					{`${costLabel} · ${formatTokens(shownTotals.totalTokens)} total (${formatTokens(shownTotals.gatewayTokens)} gateway + ${formatTokens(shownTotals.mcpTokens)} mcp) · ${scope.hint}`}
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="mb-3 flex items-center gap-2">
					<input
						aria-label="Filter by user id"
						className="h-9 w-52 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none placeholder:text-muted-foreground"
						list={listId}
						onChange={(event) => {
							setQuery(event.target.value);
						}}
						placeholder="Filter by user id"
						type="search"
						value={query}
					/>
					<datalist id={listId}>
						{users.map((userId) => (
							<option key={userId} value={userId} />
						))}
					</datalist>
				</div>
				{shownSeries.length > 0 ? (
					<ChartContainer className={CHART_HEIGHT_CLASS} config={COST_CONFIG}>
						<ComposedChart data={[...shownSeries]}>
							<CartesianGrid vertical={false} />
							<XAxis axisLine={false} dataKey="date" tickLine={false} />
							<YAxis axisLine={false} tickLine={false} yAxisId={COST_AXIS_ID} />
							<YAxis
								axisLine={false}
								orientation="right"
								tickLine={false}
								yAxisId={TOKEN_AXIS_ID}
							/>
							<ChartTooltip content={<ChartTooltipContent />} />
							<Bar
								dataKey="gatewayTokens"
								fill="var(--color-gatewayTokens)"
								radius={BAR_RADIUS}
								stackId="tokens"
								yAxisId={TOKEN_AXIS_ID}
							/>
							<Bar
								dataKey="mcpTokens"
								fill="var(--color-mcpTokens)"
								radius={BAR_RADIUS}
								stackId="tokens"
								yAxisId={TOKEN_AXIS_ID}
							/>
							<Area
								dataKey="costUsd"
								fill="var(--color-costUsd)"
								fillOpacity={AREA_FILL_OPACITY}
								stroke="var(--color-costUsd)"
								yAxisId={COST_AXIS_ID}
							/>
						</ComposedChart>
					</ChartContainer>
				) : (
					<p className="text-muted-foreground text-sm">No metered usage yet.</p>
				)}
			</CardContent>
		</Card>
	);
}
