import { ALL_ROLES, filterEscalationsByRole } from "#/components/dashboard/scope.ts";
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
import { ALL_CONSUMERS, type DashboardData, type EscalationRow } from "#/dashboard/types.ts";

const ACTIVITY_DESCRIPTION = "People, consumers, and escalations across the audit window.";
const ACTIVITY_TITLE = "Activity";
const ALL_CONSUMERS_ESCALATIONS_TITLE = "Escalations with consumer attribution";
const BY_CONSUMER_DESCRIPTION = "Decisions per consumer. Select one to view it in isolation.";
const BY_CONSUMER_TITLE = "By consumer key";
const EMPTY_STATE_MESSAGE = "No activity in this window";
const ESCALATIONS_DESCRIPTION =
	"Newest first. Each row carries the consumer key it was recorded under.";

interface ByConsumerRow {
	allow: number;
	block: number;
	escalate: number;
	key: string;
	redact: number;
	total: number;
}

function toByConsumerRows(byConsumer: DashboardData["byConsumer"]): ByConsumerRow[] {
	return Object.entries(byConsumer)
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
}

/** Escalations heading reflecting the active consumer/role scope. */
function escalationTitle(consumer: string | undefined, role: string | undefined): string {
	const scopes = [consumer, role].filter((part): part is string => part !== undefined);
	if (scopes.length === 0) {
		return ALL_CONSUMERS_ESCALATIONS_TITLE;
	}
	return `Escalations for ${scopes.join(" · ")}`;
}

/** Query href for the Overview page preserving the other scope filter. */
function overviewHref(consumer: string | undefined, role: string | undefined): string {
	const params = new URLSearchParams();
	if (consumer !== undefined) {
		params.set("consumer", consumer);
	}
	if (role !== undefined) {
		params.set("role", role);
	}
	const query = params.toString();
	return query.length > 0 ? `/?${query}` : "/";
}

/** Route-level scope banner: consumer and role filters with per-filter clears. */
function ScopeBanner({
	consumer,
	role,
}: {
	consumer: string | undefined;
	role: string | undefined;
}) {
	if (consumer === undefined && role === undefined) {
		return null;
	}
	return (
		<p className="text-muted-foreground text-sm">
			{consumer === undefined ? null : (
				<span>
					{`Showing consumer scope: ${consumer} (`}
					<a className="underline" href={overviewHref(undefined, role)}>
						Clear
					</a>
					)
				</span>
			)}
			{role === undefined ? null : (
				<span>
					{` Showing role scope: ${role} (`}
					<a className="underline" href={overviewHref(consumer, undefined)}>
						Clear
					</a>
					)
				</span>
			)}
		</p>
	);
}

/** Muted empty state shown in place of an empty table body. */
function EmptyState() {
	return <p className="text-muted-foreground text-sm">{EMPTY_STATE_MESSAGE}</p>;
}

function SectionHeading({ description, title }: { description: string; title: string }) {
	return (
		<div className="flex flex-col gap-1">
			<h2 className="font-semibold text-lg tracking-tight">{title}</h2>
			<p className="text-muted-foreground text-sm">{description}</p>
		</div>
	);
}

function ByConsumerTable({
	role,
	rows,
}: {
	role: string | undefined;
	rows: readonly ByConsumerRow[];
}) {
	return (
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
				{rows.map((row) => (
					<TableRow key={row.key}>
						<TableCell className="font-medium">
							<a className="underline" href={overviewHref(row.key, role)}>
								{row.key}
							</a>
						</TableCell>
						<TableCell className="text-right tabular-nums">{formatCount(row.allow)}</TableCell>
						<TableCell className="text-right tabular-nums">{formatCount(row.redact)}</TableCell>
						<TableCell className="text-right tabular-nums">{formatCount(row.block)}</TableCell>
						<TableCell className="text-right tabular-nums">{formatCount(row.escalate)}</TableCell>
						<TableCell className="text-right tabular-nums">{formatCount(row.total)}</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}

function EscalationsTable({ rows }: { rows: readonly EscalationRow[] }) {
	return (
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
				{rows.map((row) => (
					<TableRow key={row.id}>
						<TableCell className="tabular-nums">{formatTimestamp(row.timestamp)}</TableCell>
						<TableCell className="font-medium">{row.consumerKey}</TableCell>
						<TableCell>{row.subject}</TableCell>
						<TableCell>{row.seam}</TableCell>
						<TableCell>{row.direction}</TableCell>
						<TableCell className="text-muted-foreground">{row.reason}</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}

function ByConsumerBlock({
	role,
	rows,
}: {
	role: string | undefined;
	rows: readonly ByConsumerRow[];
}) {
	const hasRows = rows.length > 0;
	return (
		<div className="flex flex-col gap-3">
			<SectionHeading description={BY_CONSUMER_DESCRIPTION} title={BY_CONSUMER_TITLE} />
			<Card>
				<CardHeader>
					<CardTitle>{BY_CONSUMER_TITLE}</CardTitle>
					<CardDescription>{BY_CONSUMER_DESCRIPTION}</CardDescription>
				</CardHeader>
				<CardContent>
					{hasRows ? <ByConsumerTable role={role} rows={rows} /> : <EmptyState />}
				</CardContent>
			</Card>
		</div>
	);
}

function EscalationsBlock({ rows, title }: { rows: readonly EscalationRow[]; title: string }) {
	const hasRows = rows.length > 0;
	return (
		<div className="flex flex-col gap-3">
			<SectionHeading description={ESCALATIONS_DESCRIPTION} title={title} />
			<Card>
				<CardHeader>
					<CardTitle>{title}</CardTitle>
					<CardDescription>{ESCALATIONS_DESCRIPTION}</CardDescription>
				</CardHeader>
				<CardContent>{hasRows ? <EscalationsTable rows={rows} /> : <EmptyState />}</CardContent>
			</Card>
		</div>
	);
}

/**
 * Activity sections for the Overview page (`/`): the scope banner plus the
 * by-consumer key and escalations cards. `?consumer=` scopes
 * the by-consumer breakdown and the attribution rows, while `?role=` (a raw
 * policy groupId) further narrows them (`personRoles[userId]` for the
 * by-consumer rows, `subject` for the escalations). Counts come from the
 * loader summary's `byConsumer` record (no second audit read). Links target
 * `/` since this block lives on the Overview page.
 */
export function ActivitySections({
	consumer,
	data,
	role,
}: {
	consumer: string | undefined;
	data: DashboardData;
	role: string | undefined;
}) {
	const scope = consumer ?? ALL_CONSUMERS;
	const byConsumer = toByConsumerRows(data.byConsumer).filter(
		(row) => role === undefined || data.personRoles[row.key] === role,
	);
	const escalations = filterEscalationsByRole(
		selectEscalations(data, scope),
		role ?? ALL_ROLES,
		data.personRoles,
	);
	const title = escalationTitle(consumer, role);
	return (
		<div className="flex flex-col gap-8">
			<ScopeBanner consumer={consumer} role={role} />
			<SectionHeading description={ACTIVITY_DESCRIPTION} title={ACTIVITY_TITLE} />
			<ByConsumerBlock role={role} rows={byConsumer} />
			<EscalationsBlock rows={escalations} title={title} />
		</div>
	);
}
