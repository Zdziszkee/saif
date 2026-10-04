import { Badge } from "#/components/ui/badge.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card.tsx";

export interface TierStatus {
	feed: { ok: boolean; version: string };
	policy: { profile: string; version: string };
	semantic: { enabled: boolean; reason?: string | undefined };
}

/**
 * Red banner shown when the JEV semantic tier is off (usually: no
 * TYPESAFE_API_KEY). Purely presentational — pages feed it loader data so
 * the indicator is in the server-rendered HTML, never dependent on a
 * client-side fetch succeeding. Renders nothing when every tier is live.
 */
export function TierStatusBanner({ status }: { status: TierStatus | null }) {
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
