import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback } from "react";
import { Dashboard } from "#/components/dashboard/dashboard.tsx";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "#/components/ui/card.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "#/components/ui/table.tsx";
import { selectEscalations } from "#/dashboard/data.ts";
import { formatCount, formatTimestamp } from "#/dashboard/format.ts";
import { getDashboardData } from "#/dashboard/server.ts";
import { ALL_CONSUMERS } from "#/dashboard/types.ts";

function validateDashboardSearch(search: Record<string, unknown>): {
	consumer: string | undefined;
} {
	const { consumer: raw } = search;
	return {
		consumer: typeof raw === "string" && raw.length > 0 ? raw : undefined,
	};
}

export const Route = createFileRoute("/dashboard")({
	component: DashboardPage,
	loader: () => getDashboardData(),
	validateSearch: validateDashboardSearch,
});

/**
 * `/dashboard` keeps the shadcn dashboard above and layers the per-user
 * tracking below it: the `?consumer=` search param scopes the by-consumer
 * breakdown and the attribution rows, so each consumer link deep-links to
 * that consumer in isolation. Counts come from the loader summary's
 * `byConsumer` record (no second audit read); the dashboard's own scope
 * selector above keeps working on its local state.
 */
function DashboardPage() {
	const data = Route.useLoaderData();
	const { consumer } = Route.useSearch();
	const onRefresh = useCallback(() => getDashboardData(), []);

	const scope = consumer ?? ALL_CONSUMERS;
	const escalations = selectEscalations(data, scope);
	const byConsumer = Object.entries(data.byConsumer)
		.map(([key, metrics]) => ({
			allow: metrics.verdicts.allow,
			block: metrics.verdicts.block,
			escalate: metrics.verdicts.escalate,
			key,
			redact: metrics.verdicts.redact,
			total:
				metrics.verdicts.allow +
				metrics.verdicts.redact +
				metrics.verdicts.block +
				metrics.verdicts.escalate,
		}))
		.sort((left, right) => right.total - left.total);

	return (
		<>
			<Dashboard initialData={data} onRefresh={onRefresh} />
			<div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 pb-6">
				{consumer === undefined ? null : (
					<p className="text-muted-foreground text-sm">
						{`Showing consumer scope: ${consumer} (`}
						<Link className="underline" search={{ consumer: undefined }} to="/dashboard">
							Clear
						</Link>
						)
					</p>
				)}
				<div className="flex flex-col gap-3">
					<div className="flex flex-col gap-1">
						<h2 className="font-semibold text-lg tracking-tight">By consumer key</h2>
						<p className="text-muted-foreground text-sm">
							Decisions per consumer. Select one to view it in isolation.
						</p>
					</div>
					<Card>
						<CardHeader>
							<CardTitle>By consumer key</CardTitle>
							<CardDescription>
								Decisions per consumer. Select one to view it in isolation.
							</CardDescription>
						</CardHeader>
						<CardContent>
							{byConsumer.length > 0 ? (
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>Consumer</TableHead>
											<TableHead className="text-right">Allow</TableHead>
											<TableHead className="text-right">Redact</TableHead>
											<TableHead className="text-right">Block</TableHead>
											<TableHead className="text-right">Escalate</TableHead>
											<TableHead className="text-right">Total</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{byConsumer.map((row) => (
											<TableRow key={row.key}>
												<TableCell className="font-medium">
													<Link
														className="underline"
														search={{ consumer: row.key }}
														to="/dashboard"
													>
														{row.key}
													</Link>
												</TableCell>
												<TableCell className="text-right tabular-nums">
													{formatCount(row.allow)}
												</TableCell>
												<TableCell className="text-right tabular-nums">
													{formatCount(row.redact)}
												</TableCell>
												<TableCell className="text-right tabular-nums">
													{formatCount(row.block)}
												</TableCell>
												<TableCell className="text-right tabular-nums">
													{formatCount(row.escalate)}
												</TableCell>
												<TableCell className="text-right tabular-nums">
													{formatCount(row.total)}
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							) : (
								<p className="text-muted-foreground text-sm">No activity in this window</p>
							)}
						</CardContent>
					</Card>
				</div>
				<div className="flex flex-col gap-3">
					<div className="flex flex-col gap-1">
						<h2 className="font-semibold text-lg tracking-tight">
							{consumer === undefined
								? "Escalations with consumer attribution"
								: `Escalations for ${consumer}`}
						</h2>
						<p className="text-muted-foreground text-sm">
							Newest first. Each row carries the consumer key it was recorded under.
						</p>
					</div>
					<Card>
						<CardHeader>
							<CardTitle>
								{consumer === undefined
									? "Escalations with consumer attribution"
									: `Escalations for ${consumer}`}
							</CardTitle>
							<CardDescription>
								Newest first. Each row carries the consumer key it was recorded under.
							</CardDescription>
						</CardHeader>
						<CardContent>
							{escalations.length > 0 ? (
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>When</TableHead>
											<TableHead>Consumer</TableHead>
											<TableHead>Subject</TableHead>
											<TableHead>Seam</TableHead>
											<TableHead>Direction</TableHead>
											<TableHead>Reason</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{escalations.map((row) => (
											<TableRow key={row.id}>
												<TableCell className="tabular-nums">
													{formatTimestamp(row.timestamp)}
												</TableCell>
												<TableCell className="font-medium">{row.consumerKey}</TableCell>
												<TableCell>{row.subject}</TableCell>
												<TableCell>{row.seam}</TableCell>
												<TableCell>{row.direction}</TableCell>
												<TableCell className="text-muted-foreground">{row.reason}</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							) : (
								<p className="text-muted-foreground text-sm">No activity in this window</p>
							)}
						</CardContent>
					</Card>
				</div>
			</div>
		</>
	);
}
