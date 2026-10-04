import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { StatCard } from "#/components/dashboard/stat-card.tsx";
import {
	type ChartConfig,
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
} from "#/components/ui/chart.tsx";
import { Progress } from "#/components/ui/progress.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "#/components/ui/table.tsx";
import {
	formatCount,
	formatMs,
	formatTimeLabel,
	formatTokens,
	formatUsd,
	usagePercent,
} from "#/dashboard/format.ts";
import type { ConsumerMetrics } from "#/dashboard/types.ts";

const CHART_HEIGHT_CLASS = "h-[220px]";
const BAR_CORNER_RADIUS = 4;
const BAR_RADIUS: [number, number, number, number] = [BAR_CORNER_RADIUS, BAR_CORNER_RADIUS, 0, 0];
const THREAT_AXIS_WIDTH = 120;
const CHART_MARGIN_LEFT = 8;
const AREA_FILL_OPACITY = 0.3;
const COST_AXIS_ID = "cost";
const TOKEN_AXIS_ID = "tokens";

const VERDICT_CONFIG: ChartConfig = {
	allow: { color: "var(--chart-2)", label: "Allow" },
	block: { color: "var(--chart-5)", label: "Block" },
	escalate: { color: "var(--chart-4)", label: "Escalate" },
	redact: { color: "var(--chart-3)", label: "Redact" },
};

const THREAT_CONFIG: ChartConfig = {
	blocked: { color: "var(--chart-5)", label: "Blocked" },
	flagged: { color: "var(--chart-4)", label: "Flagged" },
	redacted: { color: "var(--chart-3)", label: "Redacted" },
};

const USAGE_CONFIG: ChartConfig = {
	costUsd: { color: "var(--chart-1)", label: "Cost (USD)" },
	tokens: { color: "var(--chart-2)", label: "Tokens" },
};

/** Muted empty state shown in place of an empty table body. */
function EmptyRows() {
	return <p className="text-muted-foreground text-sm">No activity in this window</p>;
}

/** Overall security posture: recent verdict counts (spec, posture overview). */
export function PostureSection({ metrics }: { metrics: ConsumerMetrics }) {
	const rows = [
		{ count: metrics.verdicts.allow, verdict: "allow" },
		{ count: metrics.verdicts.redact, verdict: "redact" },
		{ count: metrics.verdicts.block, verdict: "block" },
		{ count: metrics.verdicts.escalate, verdict: "escalate" },
	];
	return (
		<section aria-label="Security posture" className="flex flex-col gap-4">
			<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
				<StatCard
					hint="interactions forwarded unchanged"
					label="Allow"
					value={formatCount(metrics.verdicts.allow)}
				/>
				<StatCard
					hint={`${formatCount(metrics.redactions)} spans redacted`}
					label="Redact"
					value={formatCount(metrics.verdicts.redact)}
				/>
				<StatCard
					hint="interactions stopped"
					label="Block"
					value={formatCount(metrics.verdicts.block)}
				/>
				<StatCard
					hint="awaiting human review"
					label="Escalate"
					value={formatCount(metrics.verdicts.escalate)}
				/>
			</div>
			<ChartContainer className={CHART_HEIGHT_CLASS} config={VERDICT_CONFIG}>
				<BarChart data={rows}>
					<CartesianGrid vertical={false} />
					<XAxis axisLine={false} dataKey="verdict" tickLine={false} />
					<YAxis allowDecimals={false} axisLine={false} tickLine={false} />
					<ChartTooltip content={<ChartTooltipContent />} />
					<Bar dataKey="count" fill="var(--color-allow)" radius={BAR_RADIUS} />
				</BarChart>
			</ChartContainer>
		</section>
	);
}

/** Blocked and redacted threats broken down by control and category. */
export function ThreatsSection({ metrics }: { metrics: ConsumerMetrics }) {
	const hasRows = metrics.threats.length > 0;
	return (
		<section aria-label="Threat breakdown" className="flex flex-col gap-4">
			{hasRows ? (
				<ChartContainer className={CHART_HEIGHT_CLASS} config={THREAT_CONFIG}>
					<BarChart
						data={[...metrics.threats]}
						layout="vertical"
						margin={{ left: CHART_MARGIN_LEFT }}
					>
						<CartesianGrid horizontal={false} />
						<XAxis allowDecimals={false} axisLine={false} tickLine={false} type="number" />
						<YAxis
							axisLine={false}
							dataKey="category"
							tickLine={false}
							type="category"
							width={THREAT_AXIS_WIDTH}
						/>
						<ChartTooltip content={<ChartTooltipContent />} />
						<Bar
							dataKey="blocked"
							fill="var(--color-blocked)"
							radius={BAR_RADIUS}
							stackId="threats"
						/>
						<Bar dataKey="redacted" fill="var(--color-redacted)" stackId="threats" />
						<Bar
							dataKey="flagged"
							fill="var(--color-flagged)"
							radius={BAR_RADIUS}
							stackId="threats"
						/>
					</BarChart>
				</ChartContainer>
			) : null}
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Control</TableHead>
						<TableHead>Category</TableHead>
						<TableHead className="text-right">Blocked</TableHead>
						<TableHead className="text-right">Redacted</TableHead>
						<TableHead className="text-right">Flagged</TableHead>
					</TableRow>
				</TableHeader>
				{hasRows ? (
					<TableBody>
						{metrics.threats.map((threat) => (
							<TableRow key={`${threat.controlId}-${threat.category}`}>
								<TableCell>{threat.controlId}</TableCell>
								<TableCell>{threat.category}</TableCell>
								<TableCell className="text-right tabular-nums">{threat.blocked}</TableCell>
								<TableCell className="text-right tabular-nums">{threat.redacted}</TableCell>
								<TableCell className="text-right tabular-nums">{threat.flagged}</TableCell>
							</TableRow>
						))}
					</TableBody>
				) : null}
			</Table>
			{hasRows ? null : <EmptyRows />}
		</section>
	);
}

/** Resource and cost consumption against configured budget limits. */
export function BudgetSection({ metrics }: { metrics: ConsumerMetrics }) {
	const series = metrics.budgetSeries.map((point) => ({
		costUsd: point.costUsd,
		label: formatTimeLabel(point.at),
		tokens: point.tokens,
	}));
	const hasSeries = series.length > 0;
	const hasRules = metrics.budget.length > 0;
	return (
		<section aria-label="Budget usage" className="flex flex-col gap-4">
			{hasSeries ? (
				<ChartContainer className={CHART_HEIGHT_CLASS} config={USAGE_CONFIG}>
					<AreaChart data={series}>
						<CartesianGrid vertical={false} />
						<XAxis axisLine={false} dataKey="label" tickLine={false} />
						<YAxis axisLine={false} tickLine={false} yAxisId={COST_AXIS_ID} />
						<YAxis axisLine={false} orientation="right" tickLine={false} yAxisId={TOKEN_AXIS_ID} />
						<ChartTooltip content={<ChartTooltipContent />} />
						<Area
							dataKey="costUsd"
							fill="var(--color-costUsd)"
							fillOpacity={AREA_FILL_OPACITY}
							stroke="var(--color-costUsd)"
							yAxisId={COST_AXIS_ID}
						/>
						<Area
							dataKey="tokens"
							fill="var(--color-tokens)"
							fillOpacity={AREA_FILL_OPACITY}
							stroke="var(--color-tokens)"
							yAxisId={TOKEN_AXIS_ID}
						/>
					</AreaChart>
				</ChartContainer>
			) : null}
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Key</TableHead>
						<TableHead>Scope</TableHead>
						<TableHead>Window</TableHead>
						<TableHead>Usage vs limit</TableHead>
						<TableHead className="text-right">Used</TableHead>
						<TableHead className="text-right">Limit</TableHead>
					</TableRow>
				</TableHeader>
				{hasRules ? (
					<TableBody>
						{metrics.budget.map((rule) => (
							<TableRow key={`${rule.consumerKey}-${rule.metric}-${rule.period}`}>
								<TableCell>{rule.consumerKey}</TableCell>
								<TableCell>{rule.modelScope}</TableCell>
								<TableCell>{`per ${rule.period}`}</TableCell>
								<TableCell>
									<div className="flex items-center gap-2">
										<Progress className="w-24" value={usagePercent(rule.used, rule.limit)} />
										<span className="text-muted-foreground text-xs tabular-nums">
											{`${usagePercent(rule.used, rule.limit)}%`}
										</span>
									</div>
								</TableCell>
								<TableCell className="text-right tabular-nums">
									{formatMetric(rule.metric, rule.used)}
								</TableCell>
								<TableCell className="text-right tabular-nums">
									{formatMetric(rule.metric, rule.limit)}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				) : null}
			</Table>
			{hasRules ? null : <EmptyRows />}
		</section>
	);
}

function formatMetric(metric: string, value: number): string {
	if (metric === "costUsd") {
		return formatUsd(value);
	}
	if (metric === "tokens") {
		return formatTokens(value);
	}
	return formatCount(value);
}

/** Pipeline latency percentiles (spec, latency requirement). */
export function LatencySection({ metrics }: { metrics: ConsumerMetrics }) {
	return (
		<section aria-label="Pipeline latency" className="grid gap-4 sm:grid-cols-3">
			<StatCard hint="median pipeline latency" label="p50" value={formatMs(metrics.latency.p50)} />
			<StatCard hint="95th percentile" label="p95" value={formatMs(metrics.latency.p95)} />
			<StatCard hint="99th percentile" label="p99" value={formatMs(metrics.latency.p99)} />
		</section>
	);
}
