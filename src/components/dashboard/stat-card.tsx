import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card.tsx";

/** Compact stat card used across the metric sections. */
export function StatCard({
	label,
	value,
	hint,
	icon,
}: {
	hint?: string | undefined;
	icon?: ReactNode | undefined;
	label: string;
	value: string;
}) {
	return (
		<Card className="py-4">
			<CardHeader className="pb-2">
				<CardTitle className="flex items-center gap-2 text-muted-foreground text-sm">
					{icon}
					{label}
				</CardTitle>
			</CardHeader>
			<CardContent>
				<div className="font-semibold tabular-nums text-2xl">{value}</div>
				{hint === undefined ? null : (
					<p className="text-muted-foreground text-xs">{hint}</p>
				)}
			</CardContent>
		</Card>
	);
}
