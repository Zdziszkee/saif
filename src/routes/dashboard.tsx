import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { TierStatusBanner } from "#/components/tier-status.tsx";
import { Badge } from "#/components/ui/badge.tsx";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "#/components/ui/card.tsx";
import type { AuditDecisionSummary } from "#/control/audit.ts";
import { engineOfControlId } from "#/control/guard-api.ts";

const REFRESH_INTERVAL_MS = 5000;

function isSummary(value: unknown): value is AuditDecisionSummary {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as {
		byControl?: unknown;
		byVerdict?: unknown;
		recent?: unknown;
		total?: unknown;
	};
	return (
		Array.isArray(record.byControl) &&
		Array.isArray(record.byVerdict) &&
		Array.isArray(record.recent) &&
		typeof record.total === "number"
	);
}

export const Route = createFileRoute("/dashboard")({ component: Dashboard });

function Dashboard() {
	const [data, setData] = useState<AuditDecisionSummary | null>(null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		let cancelled = false;
		function refresh(): void {
			fetch("/api/decisions")
				.then((response) =>
					response.ok
						? (response.json() as Promise<unknown>)
						: Promise.reject(new Error("decisions failed")),
				)
				.then((body) => {
					if (!cancelled && isSummary(body)) {
						setData(body);
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
							</a>{" "}
							<span>(exports require a consumer key)</span>
						</span>
					)}
				</p>
			</header>
			<TierStatusBanner />
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
							<CardDescription>
								One row per guard decision, newest first. Refreshes every 5 seconds.
							</CardDescription>
						</CardHeader>
						<CardContent>
							<ul className="mt-1 space-y-1 font-mono text-sm">
								{data.recent.map((event) => (
									<li key={`${event.timestamp}-${event.interactionId ?? ""}`}>
										{event.timestamp} [{event.verdict ?? "?"}] [
										{engineOfControlId(event.controlId ?? "pipeline")}] {event.controlId ?? ""}{" "}
										{event.subject ?? ""} ({event.seam ?? "?"})
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
