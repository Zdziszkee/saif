import { useEffect, useState } from "react";

import { Badge } from "#/components/ui/badge.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card.tsx";
import type { SemanticMode } from "#/hub/runtime.ts";

export interface TierStatus {
	feed: { ok: boolean; version: string };
	policy: { profile: string; version: string };
	semantic: { enabled: boolean; mode?: SemanticMode | undefined; reason?: string | undefined };
}

function isTierStatus(value: unknown): value is TierStatus {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as { semantic?: unknown };
	if (typeof record.semantic !== "object" || record.semantic === null) {
		return false;
	}
	const semantic = record.semantic as { enabled?: unknown; mode?: unknown };
	if (typeof semantic.enabled !== "boolean") {
		return false;
	}
	return (
		semantic.mode === undefined ||
		semantic.mode === "live" ||
		semantic.mode === "mock" ||
		semantic.mode === "off"
	);
}

/**
 * Pure tier banner for one `/api/status` snapshot: three states — live
 * renders nothing, mock explains the heuristic tier, off explains the
 * disabled tier. Split from `TierStatusBanner` so render tests can assert
 * every state with `renderToStaticMarkup` (effects never run there).
 */
export function TierStatusBannerContent({ status }: { status: TierStatus | null }) {
	if (status === null) {
		return null;
	}
	if (status.semantic.enabled) {
		if (status.semantic.mode !== "mock") {
			return null;
		}
		return (
			<Card className="border-secondary" data-mode="mock" data-testid="tier-status-banner">
				<CardHeader>
					<CardTitle>
						<Badge variant="secondary">JEV mock tier</Badge>
					</CardTitle>
				</CardHeader>
				<CardContent className="text-sm">
					<p>
						Mock semantic tier active — verdicts come from the mock-jev keyword heuristic, not the
						live decision model.
					</p>
					<p className="text-muted-foreground">
						Regex + signature feed still enforced alongside the mock heuristic; set TYPESAFE_API_KEY
						for live JEV checks.
					</p>
				</CardContent>
			</Card>
		);
	}
	return (
		<Card className="border-destructive" data-mode="off" data-testid="tier-status-banner">
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

/**
 * Tier banner for the JEV semantic tier. Fetches `/api/status` keyless (the
 * endpoint carries no user content): route loaders also execute in the
 * browser on client-side navigation, so the banner must not depend on loader
 * data backed by node APIs. Renders nothing while loading or when the live
 * tier is enabled; shows the mock or off banner otherwise.
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

	return <TierStatusBannerContent status={status} />;
}
