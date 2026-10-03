import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { Badge } from "#/components/ui/badge.tsx";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "#/components/ui/card.tsx";
import {
	type AuditDecisionSummary,
	readAuditEvents,
	summarizeAuditDecisions,
} from "#/control/audit.ts";
import { getAuditSink } from "#/hub/runtime.ts";

const RECENT_LIMIT = 20;
const REFRESH_INTERVAL_MS = 5000;

export const Route = createFileRoute("/dashboard")({
	component: Dashboard,
	// Server-side: reads the audit sink directly, so the page works without a
	// consumer key while the bulk JSONL/CSV export endpoint stays key-gated.
	loader: (): AuditDecisionSummary =>
		summarizeAuditDecisions(readAuditEvents(getAuditSink()), RECENT_LIMIT),
});

function Dashboard() {
	const data = Route.useLoaderData();
	const router = useRouter();

	useEffect(() => {
		const timer = setInterval(() => {
			router.invalidate().catch(() => undefined);
		}, REFRESH_INTERVAL_MS);
		return () => {
			clearInterval(timer);
		};
	}, [router]);

	return (
		<main className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
			<header className="flex flex-col gap-2">
				<Badge className="w-fit">Observability</Badge>
				<h1 className="text-3xl font-bold tracking-tight">Security dashboard</h1>
				<p className="text-muted-foreground text-sm">
					<span>
						{data.total} audited decisions this session.{" "}
						<a className="underline" href="/api/audit/export?format=jsonl">
							JSONL
						</a>{" "}
						·{" "}
						<a className="underline" href="/api/audit/export?format=csv">
							CSV
						</a>{" "}
						<span>(exports require a consumer key)</span>
					</span>
				</p>
			</header>
			<div className="grid grid-cols-2 gap-4">
				<Card>
					<CardHeader>
						<CardTitle>By verdict</CardTitle>
					</CardHeader>
					<CardContent>
						<ul className="mt-1 space-y-1 font-mono text-sm">
							{data.byVerdict.map(([verdict, count]) => (
								<li key={verdict}>
									{verdict}: {count}
								</li>
							))}
						</ul>
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle>By control</CardTitle>
						<CardDescription>Which engine decided.</CardDescription>
					</CardHeader>
					<CardContent>
						<ul className="mt-1 space-y-1 font-mono text-sm">
							{data.byControl.map(([control, count]) => (
								<li key={control}>
									{control}: {count}
								</li>
							))}
						</ul>
					</CardContent>
				</Card>
			</div>
			<Card>
				<CardHeader>
					<CardTitle>Recent decisions</CardTitle>
					<CardDescription>
						One row per guard decision, newest first. Refreshes every 5 seconds.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<ul className="mt-1 space-y-1 font-mono text-sm">
						{data.recent.map((event) => (
							<li key={`${event.timestamp}-${event.interactionId ?? ""}`}>
								{event.timestamp} [{event.verdict ?? "?"}] {event.controlId ?? ""}{" "}
								{event.subject ?? ""} ({event.seam ?? "?"})
							</li>
						))}
					</ul>
				</CardContent>
			</Card>
		</main>
	);
}
