import { useEffect, useState } from "react";

import { Badge } from "#/components/ui/badge.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card.tsx";

export interface TierStatus {
	feed: { ok: boolean; version: string };
	policy: { profile: string; version: string };
	semantic: { enabled: boolean; reason?: string | undefined };
}

function isTierStatus(value: unknown): value is TierStatus {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as { semantic?: unknown };
	if (typeof record.semantic !== "object" || record.semantic === null) {
		return false;
	}
	const semantic = record.semantic as { enabled?: unknown };
	return typeof semantic.enabled === "boolean";
}

/**
 * Red banner shown when the JEV semantic tier is off (usually: no
 * TYPESAFE_API_KEY). Fetches `/api/status` client-side: route loaders also
 * execute in the browser on client-side navigation, so the banner must not
 * depend on loader data backed by node APIs. Renders nothing while loading
 * or when every tier is live.
 */
export function TierStatusBanner() {
	const [status, setStatus] = useState<TierStatus | null>(null);

	useEffect(() => {
		let cancelled = false;
		fetch("/api/status")
			.then((response) =>
				response.ok
					? (response.json() as Promise<unknown>)
					: Promise.reject(new Error("status failed")),
			)
			.then((body) => {
				if (!cancelled && isTierStatus(body)) {
					setStatus(body);
				}
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, []);

	if (status === null || status.semantic.enabled) {
		return null;
	}
	return (
		<Card className="border-destructive" data-testid="tier-status-banner">
			<CardHeader>
				<CardTitle>
					<Badge variant="destructive">JEV semantic tier off</Badge>
				</CardTitle>
			</CardHeader>
			<CardContent className="text-sm">
				<p>{status.semantic.reason ?? "Set TYPESAFE_API_KEY to enable JEV checks."}</p>
				<p className="text-muted-foreground">
					Regex + signature feed still enforced; obfuscated attacks may pass through.
				</p>
			</CardContent>
		</Card>
	);
}
