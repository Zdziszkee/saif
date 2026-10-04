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
import type { CostSeriesPoint, CostTotals } from "#/dashboard/types.ts";

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

/** Daily metered spend: stacked gateway/MCP token bars plus a cost area. */
export function CostPlot({
	series,
	totals,
}: {
	series: readonly CostSeriesPoint[];
	totals: CostTotals;
}) {
	const costLabel = totals.costUsd === null ? "unpriced" : formatUsd(totals.costUsd);
	return (
		<Card>
			<CardHeader>
				<CardTitle>Cost and tokens</CardTitle>
				<CardDescription>
					{`${costLabel} · ${formatTokens(totals.totalTokens)} total (${formatTokens(totals.gatewayTokens)} gateway + ${formatTokens(totals.mcpTokens)} mcp)`}
				</CardDescription>
			</CardHeader>
			<CardContent>
				{series.length > 0 ? (
					<ChartContainer className={CHART_HEIGHT_CLASS} config={COST_CONFIG}>
						<ComposedChart data={[...series]}>
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
