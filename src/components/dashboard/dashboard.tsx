import { useCallback, useEffect, useMemo, useState } from "react";
import {
	BudgetSection,
	LatencySection,
	PostureSection,
	ThreatsSection,
} from "#/components/dashboard/metric-sections.tsx";
import { PeopleSection } from "#/components/dashboard/people-sections.tsx";
import { matchesPerson, roleLabel } from "#/components/dashboard/persons.ts";
import {
	ControlsSection,
	EscalationsSection,
	ProfilesSection,
} from "#/components/dashboard/policy-sections.tsx";
import { ThemeSwitcher } from "#/components/theme-switcher.tsx";
import { TierStatusBanner } from "#/components/tier-status.tsx";
import { Badge } from "#/components/ui/badge.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select.tsx";
import { Separator } from "#/components/ui/separator.tsx";
import { selectEscalations, selectMetrics } from "#/dashboard/data.ts";
import { formatTimestamp } from "#/dashboard/format.ts";
import { ALL_CONSUMERS, type DashboardData, type EscalationRow } from "#/dashboard/types.ts";

const ALL_ROLES = "all";
const UNKNOWN_ROLE = "unknown";

const REFRESH_INTERVAL_MS = 15_000;
const MS_PER_SECOND = 1000;
const REFRESH_INTERVAL_SECONDS = REFRESH_INTERVAL_MS / MS_PER_SECOND;
const POLICY_VERSION_PREVIEW_LENGTH = 12;

function SectionTitle({ title, description }: { description: string; title: string }) {
	return (
		<div className="flex flex-col gap-1">
			<h2 className="font-semibold text-lg tracking-tight">{title}</h2>
			<p className="text-muted-foreground text-sm">{description}</p>
		</div>
	);
}

function ConsumerSelect({
	consumerKeys,
	value,
	onChange,
}: {
	consumerKeys: readonly string[];
	onChange: (next: string) => void;
	value: string;
}) {
	return (
		<Select onValueChange={onChange} value={value}>
			<SelectTrigger aria-label="Consumer key scope" className="w-52">
				<SelectValue placeholder="Consumer key" />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value={ALL_CONSUMERS}>All consumers</SelectItem>
				{consumerKeys.map((key) => (
					<SelectItem key={key} value={key}>
						{key}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

/**
 * Consumer scope state for the dashboard dropdown. The route's `?consumer=`
 * search param is the source of truth: `initialConsumer` seeds the state and
 * resyncs it whenever the route selection changes, while dropdown changes
 * update local state immediately and report through `onConsumerChange` so the
 * route can navigate (set or clear `?consumer=`).
 */
function useConsumerScope(
	initialConsumer: string | undefined,
	onConsumerChange: ((next: string) => void) | undefined,
): { consumer: string; handleConsumerChange: (next: string) => void } {
	const [consumer, setConsumer] = useState<string>(initialConsumer ?? ALL_CONSUMERS);

	useEffect(() => {
		if (initialConsumer !== undefined) {
			setConsumer(initialConsumer);
		}
	}, [initialConsumer]);

	const handleConsumerChange = useCallback(
		(next: string) => {
			setConsumer(next);
			onConsumerChange?.(next);
		},
		[onConsumerChange],
	);

	return { consumer, handleConsumerChange };
}

function RoleSelect({
	onChange,
	roles,
	value,
}: {
	onChange: (next: string) => void;
	roles: readonly string[];
	value: string;
}) {
	return (
		<Select onValueChange={onChange} value={value}>
			<SelectTrigger aria-label="Role scope" className="w-52">
				<SelectValue placeholder="Role" />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value={ALL_ROLES}>All roles</SelectItem>
				{roles.map((role) => (
					<SelectItem key={role} value={role}>
						{roleLabel(role)}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

/**
 * Role scope state for the people filter. Mirrors `useConsumerScope`: the
 * route's `?role=` search param is the source of truth, `initialRole` seeds
 * the state and resyncs it whenever the route selection changes, while
 * dropdown changes update local state immediately and report through
 * `onRoleChange` so the route can navigate (set or clear `?role=`). Without
 * the callback the dropdown stays purely local.
 */
function useRoleScope(
	initialRole: string | undefined,
	onRoleChange: ((next: string) => void) | undefined,
): { handleRoleChange: (next: string) => void; role: string } {
	const [role, setRole] = useState<string>(initialRole ?? ALL_ROLES);

	useEffect(() => {
		if (initialRole !== undefined) {
			setRole(initialRole);
		}
	}, [initialRole]);

	const handleRoleChange = useCallback(
		(next: string) => {
			setRole(next);
			onRoleChange?.(next);
		},
		[onRoleChange],
	);

	return { handleRoleChange, role };
}

/** Distinct roles in use, sorted for the filter dropdown. */
function distinctRoles(personRoles: Readonly<Record<string, string>>): string[] {
	return [...new Set(Object.values(personRoles))].sort((left, right) => left.localeCompare(right));
}

interface PeopleTableRow {
	allow: number;
	block: number;
	escalate: number;
	groupId: string;
	redact: number;
	total: number;
	userId: string;
}

/** People rows from the by-consumer verdicts, filtered and sorted by total desc. */
function toPeopleRows(
	byConsumer: DashboardData["byConsumer"],
	personRoles: Readonly<Record<string, string>>,
	query: string,
	role: string,
): PeopleTableRow[] {
	return Object.entries(byConsumer)
		.map(([userId, metrics]) => ({
			allow: metrics.verdicts.allow,
			block: metrics.verdicts.block,
			escalate: metrics.verdicts.escalate,
			groupId: personRoles[userId] ?? UNKNOWN_ROLE,
			redact: metrics.verdicts.redact,
			total:
				metrics.verdicts.allow +
				metrics.verdicts.redact +
				metrics.verdicts.block +
				metrics.verdicts.escalate,
			userId,
		}))
		.filter(
			(row) => (role === ALL_ROLES || row.groupId === role) && matchesPerson(row.userId, query),
		)
		.sort((left, right) => right.total - left.total);
}

/**
 * Scope escalation rows to one role. A row matches when its subject is the
 * role or when its consumer maps to the role, so both group-attributed and
 * legacy consumer-attributed rows stay visible under their role.
 */
function filterEscalationsByRole(
	rows: readonly EscalationRow[],
	role: string,
	personRoles: Readonly<Record<string, string>>,
): readonly EscalationRow[] {
	if (role === ALL_ROLES) {
		return rows;
	}
	return rows.filter(
		(row) => row.subject === role || (personRoles[row.consumerKey] ?? "") === role,
	);
}

/**
 * People section with its local search box and role filter. The search query
 * is owned by the caller as plain local state (never reflected in the URL);
 * the role value comes from `useRoleScope` so the URL stays the source of
 * truth when the route threads `?role=` through.
 */
function PeopleBlock({
	onQueryChange,
	onRoleChange,
	query,
	role,
	roles,
	rows,
}: {
	onQueryChange: (next: string) => void;
	onRoleChange: (next: string) => void;
	query: string;
	role: string;
	roles: readonly string[];
	rows: readonly PeopleTableRow[];
}) {
	return (
		<>
			<div className="flex flex-col gap-3">
				<SectionTitle
					description="People activity: verdict counts per person, filterable by name and role."
					title="People"
				/>
				<div className="flex flex-wrap items-center gap-2">
					<input
						aria-label="Search people"
						className="h-9 w-52 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none placeholder:text-muted-foreground"
						onChange={(event) => onQueryChange(event.target.value)}
						placeholder="Search people"
						type="search"
						value={query}
					/>
					<RoleSelect onChange={onRoleChange} roles={roles} value={role} />
				</div>
				<PeopleSection rows={rows} />
			</div>
			<Separator />
		</>
	);
}

/**
 * Dashboard header: title, version badges, and the consumer scope dropdown.
 * The dropdown reports through `onConsumerChange` so the route stays the
 * source of truth for `?consumer=`; no navigation happens here.
 */
function DashboardHeader({
	consumer,
	consumerKeys,
	data,
	onConsumerChange,
}: {
	consumer: string;
	consumerKeys: readonly string[];
	data: DashboardData;
	onConsumerChange: (next: string) => void;
}) {
	return (
		<header className="flex flex-wrap items-start justify-between gap-4">
			<div className="flex flex-col gap-2">
				<div className="flex items-center gap-3">
					<h1 className="font-bold text-2xl tracking-tight">Saif security dashboard</h1>
					<Badge variant="outline">AI Control Layer</Badge>
				</div>
				<p className="text-muted-foreground text-sm">
					Controls, posture, threats, budget, and latency across all governed interactions.
				</p>
				<div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
					<Badge title={data.policyVersion} variant="secondary">
						{`policy ${data.policyVersion.slice(0, POLICY_VERSION_PREVIEW_LENGTH)}`}
					</Badge>
					<Badge variant="secondary">{`feed ${data.feedVersion}`}</Badge>
					<span>{`default profile: ${data.policy.defaultProfile}`}</span>
					<span>{`failure verdict: ${data.policy.failureVerdict}`}</span>
				</div>
			</div>
			<div className="flex items-center gap-2">
				<ConsumerSelect consumerKeys={consumerKeys} onChange={onConsumerChange} value={consumer} />
				<ThemeSwitcher />
			</div>
		</header>
	);
}

/**
 * People scope for the dashboard: role state (URL-backed like the consumer
 * scope), the local person search query, the distinct roles, the filtered
 * people rows, and the role-scoped escalation queue. Keeps the `Dashboard`
 * body small; the route stays the source of truth for `?role=` through
 * `initialRole`/`onRoleChange`.
 */
function usePeopleScope(
	data: DashboardData,
	consumer: string,
	initialRole: string | undefined,
	onRoleChange: ((next: string) => void) | undefined,
): {
	escalations: readonly EscalationRow[];
	handleRoleChange: (next: string) => void;
	peopleRows: PeopleTableRow[];
	query: string;
	role: string;
	roles: string[];
	setQuery: (next: string) => void;
} {
	const { handleRoleChange, role } = useRoleScope(initialRole, onRoleChange);
	const [query, setQuery] = useState<string>("");
	const roles = useMemo(() => distinctRoles(data.personRoles), [data]);
	const peopleRows = useMemo(
		() => toPeopleRows(data.byConsumer, data.personRoles, query, role),
		[data, query, role],
	);
	const escalations = useMemo(
		() => filterEscalationsByRole(selectEscalations(data, consumer), role, data.personRoles),
		[data, consumer, role],
	);
	return { escalations, handleRoleChange, peopleRows, query, role, roles, setQuery };
}

/**
 * Interactive dashboard (security-observability spec): controls and profiles
 * in force, posture, threats by control/category, budget vs limits, latency
 * percentiles, escalations, versions in force, per-consumer breakdown, and
 * live refresh via polling.
 *
 * `initialConsumer` seeds the consumer scope dropdown from the route's
 * `?consumer=` search param (URL is the source of truth: the effect below
 * resyncs local state whenever the route selection changes). `onConsumerChange`
 * reports dropdown changes so the route can navigate to `?consumer=` (or clear
 * it for the aggregate scope); without it the dropdown stays purely local.
 *
 * `initialRole`/`onRoleChange` mirror that pair for the role filter from the
 * route's `?role=` search param (`undefined` means all roles). The role
 * selection filters the People table and the escalation queue; the person
 * search box stays local and is never reflected in the URL.
 */
export function Dashboard({
	initialConsumer,
	initialData,
	initialRole,
	onConsumerChange,
	onRefresh,
	onRoleChange,
}: {
	initialConsumer?: string | undefined;
	initialData: DashboardData;
	initialRole?: string | undefined;
	onConsumerChange?: ((next: string) => void) | undefined;
	onRefresh: () => Promise<DashboardData>;
	onRoleChange?: ((next: string) => void) | undefined;
}) {
	const [data, setData] = useState<DashboardData>(initialData);
	const { consumer, handleConsumerChange } = useConsumerScope(initialConsumer, onConsumerChange);
	const { escalations, handleRoleChange, peopleRows, query, role, roles, setQuery } =
		usePeopleScope(data, consumer, initialRole, onRoleChange);

	useEffect(() => {
		const timer = setInterval(() => {
			onRefresh()
				.then((next) => {
					setData(next);
				})
				.catch(() => undefined);
		}, REFRESH_INTERVAL_MS);
		return () => {
			clearInterval(timer);
		};
	}, [onRefresh]);

	const metrics = useMemo(() => selectMetrics(data, consumer), [data, consumer]);

	return (
		<main className="mx-auto flex w-full max-w-6xl flex-col gap-8 p-6">
			<DashboardHeader
				consumer={consumer}
				consumerKeys={data.consumerKeys}
				data={data}
				onConsumerChange={handleConsumerChange}
			/>

			<TierStatusBanner />

			<p className="text-muted-foreground text-xs">
				{`Live refresh every ${REFRESH_INTERVAL_SECONDS}s · last update ${formatTimestamp(data.generatedAt)}`}
			</p>

			<div className="flex flex-col gap-3">
				<SectionTitle
					description="Recent verdict counts for allow, redact, block, and escalate."
					title="Security posture"
				/>
				<PostureSection metrics={metrics} />
			</div>
			<Separator />

			<div className="flex flex-col gap-3">
				<SectionTitle
					description="Blocked and redacted threats broken down by control and category."
					title="Threat breakdown"
				/>
				<ThreatsSection metrics={metrics} />
			</div>
			<Separator />

			<div className="flex flex-col gap-3">
				<SectionTitle
					description="Resource and cost consumption over time against configured budget limits."
					title="Budget usage"
				/>
				<BudgetSection metrics={metrics} />
			</div>
			<Separator />

			<div className="flex flex-col gap-3">
				<SectionTitle
					description="Pipeline latency percentiles for the selected scope."
					title="Latency"
				/>
				<LatencySection metrics={metrics} />
			</div>
			<Separator />

			<div className="flex flex-col gap-3">
				<SectionTitle
					description="The configured controls and strictness profiles currently in force."
					title="Controls in force"
				/>
				<ControlsSection controls={data.policy.controls} />
			</div>
			<Separator />

			<div className="flex flex-col gap-3">
				<SectionTitle
					description="Strictness profiles and their inbound block thresholds."
					title="Strictness profiles"
				/>
				<ProfilesSection profiles={data.policy.profiles} />
			</div>
			<Separator />

			<PeopleBlock
				onQueryChange={setQuery}
				onRoleChange={handleRoleChange}
				query={query}
				role={role}
				roles={roles}
				rows={peopleRows}
			/>

			<div className="flex flex-col gap-3">
				<SectionTitle description="Recent escalations awaiting review." title="Escalation queue" />
				<EscalationsSection rows={escalations} />
			</div>

			<footer className="flex flex-wrap items-center justify-between gap-4 border-t pt-4">
				<p className="text-muted-foreground text-xs">
					{`Last update ${formatTimestamp(data.generatedAt)} · refreshes every ${REFRESH_INTERVAL_SECONDS}s`}
				</p>
				<p className="flex flex-wrap items-center gap-1 text-muted-foreground text-xs">
					<span>Audit export:</span>
					<a className="underline" href="/api/audit/export?format=jsonl">
						JSONL
					</a>
					<span>·</span>
					<a className="underline" href="/api/audit/export?format=csv">
						CSV
					</a>
					<span>(exports require a consumer key)</span>
				</p>
			</footer>
		</main>
	);
}
