import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { Badge } from "#/components/ui/badge.tsx";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "#/components/ui/card.tsx";

interface DashboardEvent {
	controlId?: string;
	interactionId?: string;
	subject?: string;
	timestamp: string;
	verdict?: string;
}

interface DashboardData {
	byControl: [string, number][];
	byVerdict: [string, number][];
	recent: DashboardEvent[];
	total: number;
}

const RECENT_LIMIT = 20;
const REFRESH_INTERVAL_MS = 5000;
const EXPORT_PATH = "/api/audit/export";
const EXPORT_QUERY = "?format=jsonl";

function isDashboardEvent(value: unknown): value is DashboardEvent {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as { timestamp?: unknown };
	return typeof record.timestamp === "string";
}

function parseExport(text: string): DashboardEvent[] {
	const events: DashboardEvent[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) {
			continue;
		}
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (isDashboardEvent(parsed)) {
				events.push(parsed);
			}
		} catch {
			// ignore malformed export lines
		}
	}
	return events;
}

function countBy(
	events: DashboardEvent[],
	key: (event: DashboardEvent) => string,
): [string, number][] {
	const counts = new Map<string, number>();
	for (const event of events) {
		const label = key(event);
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function summarize(events: DashboardEvent[]): DashboardData {
	return {
		byControl: countBy(events, (event) => event.controlId ?? "none"),
		byVerdict: countBy(events, (event) => event.verdict ?? "none"),
		recent: events.slice(-RECENT_LIMIT).reverse(),
		total: events.length,
	};
}

export const Route = createFileRoute("/dashboard")({ component: Dashboard });

function Dashboard() {
	const [data, setData] = useState<DashboardData | null>(null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		let cancelled = false;
		function refresh(): void {
			fetch(EXPORT_PATH + EXPORT_QUERY)
				.then((response) =>
					response.ok ? response.text() : Promise.reject(new Error("audit export failed")),
				)
				.then((text) => {
					if (!cancelled) {
						setData(summarize(parseExport(text)));
						setFailed(false);
					}
				})
				.catch(() => {
					if (!cancelled) {
						setFailed(true);
					}
				});
		}
		refresh();
		const timer = setInterval(refresh, REFRESH_INTERVAL_MS);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, []);

	return (
		<main className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
			<header className="flex flex-col gap-2">
				<Badge className="w-fit">Observability</Badge>
				<h1 className="text-3xl font-bold tracking-tight">Security dashboard</h1>
				<p className="text-muted-foreground text-sm">
					{data === null && (
						<span>{failed ? "Could not load audit data." : "Loading audit data…"}</span>
					)}
					{data !== null && (
						<span>
							{data.total} audited decisions this session.{" "}
							<a className="underline" href="/api/audit/export?format=jsonl">
								JSONL
							</a>{" "}
							·{" "}
							<a className="underline" href="/api/audit/export?format=csv">
								CSV
							</a>
						</span>
					)}
				</p>
			</header>
			{data === null ? null : (
				<>
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
							<CardDescription>Newest first, refreshes every 5 seconds.</CardDescription>
						</CardHeader>
						<CardContent>
							<ul className="mt-1 space-y-1 font-mono text-sm">
								{data.recent.map((event) => (
									<li key={`${event.timestamp}-${event.interactionId ?? ""}`}>
										{event.timestamp} [{event.verdict ?? "?"}] {event.controlId ?? ""}{" "}
										{event.subject ?? ""}
									</li>
								))}
							</ul>
						</CardContent>
					</Card>
				</>
			)}
		</main>
	);
}
