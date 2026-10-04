import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "#/components/ui/table.tsx";
import { formatCount, formatTokens, formatUsd } from "#/dashboard/format.ts";
import type { UserTokenUsage } from "#/dashboard/types.ts";

/** Per-user token usage card: one row per user, muted line when empty. */
export function UserTokenUsageCard({ usage }: { usage: UserTokenUsage[] }) {
	return (
		<Card className="py-4">
			<CardHeader className="pb-2">
				<CardTitle className="text-muted-foreground text-sm">Token usage by user</CardTitle>
			</CardHeader>
			<CardContent>
				{usage.length === 0 ? (
					<p className="text-muted-foreground text-sm">No metered usage yet.</p>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>User</TableHead>
								<TableHead className="text-right">Requests</TableHead>
								<TableHead className="text-right">Prompt</TableHead>
								<TableHead className="text-right">Completion</TableHead>
								<TableHead className="text-right">Total</TableHead>
								<TableHead className="text-right">Cost</TableHead>
								<TableHead>Models</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{usage.map((row) => (
								<TableRow key={row.userId}>
									<TableCell>{row.userId}</TableCell>
									<TableCell className="text-right tabular-nums">
										{formatCount(row.requests)}
									</TableCell>
									<TableCell className="text-right tabular-nums">
										{formatTokens(row.promptTokens)}
									</TableCell>
									<TableCell className="text-right tabular-nums">
										{formatTokens(row.completionTokens)}
									</TableCell>
									<TableCell className="text-right tabular-nums">
										{formatTokens(row.totalTokens)}
									</TableCell>
									<TableCell className="text-right tabular-nums">
										{row.costUsd === null ? "unpriced" : formatUsd(row.costUsd)}
									</TableCell>
									<TableCell className="text-muted-foreground">{row.models.join(", ")}</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</CardContent>
		</Card>
	);
}
