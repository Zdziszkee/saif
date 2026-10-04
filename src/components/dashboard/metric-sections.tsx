import {
	Area,
	AreaChart,
	Bar,
	BarChart,
	CartesianGrid,
	XAxis,
	YAxis,
} from "recharts";
import {
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
	type ChartConfig,
} from "#/components/ui/chart.tsx";
import { StatCard } from "#/components/dashboard/stat-card.tsx";
import { Progress } from "#/components/ui/progress.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "#/components/ui/table.tsx";
import { formatCount, formatTokens, formatUsd, usagePercent } from "#/dashboard/format.ts";
import type { ConsumerMetrics } from "#/dashboard/types.ts";

const CHART_HEIGHT_CLASS = "h-[220px]";
const BAR_RADIUS = [4, 4, 0, 0] as const;

const VERDICT_CONFIG: ChartConfig = {
	allow: { color: "var(--chart-2)", label: "Allow" },
	block: { color: "var(--chart-5)", label: "Block" },
	escalate: { color: "var(--chart-4)", label: "Escalate" },
	redact: { color: "var(--chart-3)", label: "Redact" },
};

const COST_CONFIG: ChartConfig = {
	costUsd: { color: "var(--chart-1)", label: "Cost (USD)" },
};

/** Overall security posture: recent verdict counts (spec, posture overview). */
export function PostureSection({ metrics }: { metrics: ConsumerMetrics }) {
	const rows = [
		{ verdict: "allow", count: metrics.verdicts.allow },
		{ verdict: "redact", count: metrics.verdicts.redact },
		{ verdict: "block", count: metrics.verdicts.block },
		{ verdict: "escalate", count: metrics.verdicts.escalate },
	];
	return (
		<section aria-label="Security posture" className="flex flex-col gap-4">
			<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
				<StatCard hint="interactions forwarded unchanged" label="Allow" value={formatCount(metrics.verdicts.allow)} />
				<StatCard hint={`${metrics.redactions} spans redacted`} label="Redact" value={formatCount(metrics.verdicts.redact)} />
				<StatCard hint="interactions stopped" label="Block" value={formatCount(metrics.verdicts.block)} />
				<StatCard hint="awaiting human review" label="Escalate" value={formatCount(metrics.verdicts.escalate)} />
			</div>
			<ChartContainer className={CHART_HEIGHT_CLASS} config={VERDICT_CONFIG}>
				<BarChart data={rows}>
					<CartesianGrid vertical={false} />
					<XAxis dataKey="verdict" tickLine={false} axisLine={false} />
					<YAxis tickLine={false} axisLine={false} allowDecimals={false} />
					<ChartTooltip content={<ChartTooltipContent />} />
					<Bar dataKey="count" fill="var(--color-allow)" radius={BAR_RADIUS} />
				</BarChart>
			</ChartContainer>
		</section>
	);
}

/** Blocked and redacted threats broken down by control and category. */
export function ThreatsSection({ metrics }: { metrics: ConsumerMetrics }) {
	return (
		<section aria-label="Threat breakdown" className="flex flex-col gap-4">
			<ChartContainer className={CHART_HEIGHT_CLASS} config={VERDICT_CONFIG}>
				<BarChart data={[...metrics.threats]} layout="vertical" margin={{ left: 8 }}>
					<CartesianGrid horizontal={false} />
					<XAxis type="number" tickLine={false} axisLine={false} allowDecimals={false} />
					<YAxis type="category" dataKey="category" tickLine={false} axisLine={false} width={120} />
					<ChartTooltip content={<ChartTooltipContent />} />
					<Bar dataKey="blocked" stackId="threats" fill="var(--chart-5)" radius={BAR_RADIUS} />
					<Bar dataKey="redacted" stackId="threats" fill="var(--chart-3)" />
					<Bar dataKey="flagged" stackId="threats" fill="var(--chart-4)" radius={BAR_RADIUS} />
				</BarChart>
			</ChartContainer>
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
			</Table>
		</section>
	);
}

/** Resource and cost consumption against configured budget limits. */
export function BudgetSection({ metrics }: { metrics: ConsumerMetrics }) {
	const series = metrics.budgetSeries.map((point) => ({
		costUsd: point.costUsd,
		label: point.at.slice(11, 16),
	}));
	return (
		<section aria-label="Budget usage" className="flex flex-col gap-4">
			<ChartContainer className={CHART_HEIGHT_CLASS} config={COST_CONFIG}>
				<AreaChart data={series}>
					<CartesianGrid vertical={false} />
					<XAxis dataKey="label" tickLine={false} axisLine={false} />
					<YAxis tickLine={false} axisLine={false} />
					<ChartTooltip content={<ChartTooltipContent />} />
					<Area dataKey="costUsd" stroke="var(--color-costUsd)" fill="var(--color-costUsd)" fillOpacity={0.3} />
				</AreaChart>
			</ChartContainer>
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
				<TableBody>
					{metrics.budget.map((rule) => (
						<TableRow key={`${rule.consumerKey}-${rule.metric}-${rule.period}`}>
							<TableCell>{rule.consumerKey}</TableCell>
							<TableCell>{rule.modelScope}</TableCell>
							<TableCell>{`per ${rule.period}`}</TableCell>
							<TableCell>
								<div className="flex items-center gap-2">
									<Progress value={usagePercent(rule.used, rule.limit)} className="w-24" />
									<span className="text-muted-foreground text-xs tabular-nums">
										{`${usagePercent(rule.used, rule.limit)}%`}
									</span>
								</div>
							</TableCell>
							<TableCell className="text-right tabular-nums">{formatMetric(rule.metric, rule.used)}</TableCell>
							<TableCell className="text-right tabular-nums">{formatMetric(rule.metric, rule.limit)}</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
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
			<StatCard hint="median pipeline latency" label="p50" value={`${metrics.latency.p50} ms`} />
			<StatCard hint="95th percentile" label="p95" value={`${metrics.latency.p95} ms`} />
			<StatCard hint="99th percentile" label="p99" value={`${metrics.latency.p99} ms`} />
		</section>
	);
}
