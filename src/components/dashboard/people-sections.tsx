import { personLabel, roleLabel } from "#/components/dashboard/persons.ts";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "#/components/ui/table.tsx";
import { formatCount } from "#/dashboard/format.ts";

interface PeopleRow {
	allow: number;
	block: number;
	escalate: number;
	groupId: string;
	redact: number;
	total: number;
	userId: string;
}

/** Muted empty state shown in place of an empty table body. */
function EmptyRows() {
	return <p className="text-muted-foreground text-sm">No activity in this window</p>;
}

/** People breakdown: one row per person with verdict counts and role. */
export function PeopleSection({ rows }: { rows: readonly PeopleRow[] }) {
	const hasRows = rows.length > 0;
	return (
		<section aria-label="People breakdown">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Person</TableHead>
						<TableHead>Role</TableHead>
						<TableHead className="text-right">Allow</TableHead>
						<TableHead className="text-right">Redact</TableHead>
						<TableHead className="text-right">Block</TableHead>
						<TableHead className="text-right">Escalate</TableHead>
						<TableHead className="text-right">Total</TableHead>
					</TableRow>
				</TableHeader>
				{hasRows ? (
					<TableBody>
						{rows.map((row) => (
							<TableRow key={row.userId}>
								<TableCell className="font-medium">
									<a className="underline" href={`?consumer=${encodeURIComponent(row.userId)}`}>
										{personLabel(row.userId)}
									</a>
								</TableCell>
								<TableCell>{roleLabel(row.groupId)}</TableCell>
								<TableCell className="text-right tabular-nums">{formatCount(row.allow)}</TableCell>
								<TableCell className="text-right tabular-nums">{formatCount(row.redact)}</TableCell>
								<TableCell className="text-right tabular-nums">{formatCount(row.block)}</TableCell>
								<TableCell className="text-right tabular-nums">
									{formatCount(row.escalate)}
								</TableCell>
								<TableCell className="text-right tabular-nums">{formatCount(row.total)}</TableCell>
							</TableRow>
						))}
					</TableBody>
				) : null}
			</Table>
			{hasRows ? null : <EmptyRows />}
		</section>
	);
}
