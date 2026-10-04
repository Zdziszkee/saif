import { useEffect, useMemo, useState } from "react";
import {
	BudgetSection,
	LatencySection,
	PostureSection,
	ThreatsSection,
} from "#/components/dashboard/metric-sections.tsx";
import { PeopleSection } from "#/components/dashboard/people-sections.tsx";
import { roleLabel } from "#/components/dashboard/persons.ts";
import { ControlsSection, ProfilesSection } from "#/components/dashboard/policy-sections.tsx";
import {
	ALL_ROLES,
	distinctRoles,
	type PeopleTableRow,
	toPeopleRows,
	useConsumerScope,
	useRoleScope,
} from "#/components/dashboard/scope.ts";
import { UserTokenUsageCard } from "#/components/dashboard/user-token-usage.tsx";
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
import { selectMetrics } from "#/dashboard/data.ts";
import { formatTimestamp } from "#/dashboard/format.ts";
import type { UserTokenUsage } from "#/dashboard/types.ts";
import {
	ALL_CONSUMERS,
	type ConsumerMetrics,
	type ControlSummary,
	type DashboardData,
	type ProfileSummary,
} from "#/dashboard/types.ts";

export type DashboardVariant = "full" | "overview";

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
 * source of truth for `?consumer=`; no navigation happens here. The
 * `overview` variant uses the Overview title/description; `full` keeps the
 * legacy title. People render in `FullVariantSections` below and escalations
 * render separately in `ActivitySections` on the Overview page.
 */
function DashboardHeader({
	consumer,
	consumerKeys,
	data,
	onConsumerChange,
	variant,
}: {
	consumer: string;
	consumerKeys: readonly string[];
	data: DashboardData;
	onConsumerChange: (next: string) => void;
	variant: DashboardVariant;
}) {
	const title = variant === "overview" ? "Overview" : "Saif security dashboard";
	const description =
		variant === "overview"
			? "Posture, threats, budget, and latency across all governed interactions."
			: "Controls, posture, threats, budget, and latency across all governed interactions.";
	return (
		<header className="flex flex-wrap items-start justify-between gap-4">
			<div className="flex flex-col gap-2">
				<div className="flex items-center gap-3">
					<h1 className="font-bold text-2xl tracking-tight">{title}</h1>
					<Badge variant="outline">AI Control Layer</Badge>
				</div>
				<p className="text-muted-foreground text-sm">{description}</p>
				<div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
					<Badge title={data.policyVersion} variant="secondary">
						{`policy ${data.policyVersion.slice(0, POLICY_VERSION_PREVIEW_LENGTH)}`}
					</Badge>
					{data.feedVersion.trim().length === 0 || data.feedVersion === "unavailable" ? (
						<Badge variant="secondary">feed unknown</Badge>
					) : (
						<Badge variant="secondary">{`feed ${data.feedVersion}`}</Badge>
					)}
					{data.semanticVersion.trim().length === 0 || data.semanticVersion === "unavailable" ? (
						<Badge variant="secondary">jev unknown</Badge>
					) : (
						<Badge variant="secondary">{`jev ${data.semanticVersion}`}</Badge>
					)}
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
 * scope), the local person search query, the distinct roles, and the filtered
 * people rows. Keeps the `Dashboard` body small; the route stays the source
 * of truth for `?role=` through `initialRole`/`onRoleChange`. Escalations
 * render separately in `ActivitySections` on the Overview page.
 */
function usePeopleScope(
	data: DashboardData,
	initialRole: string | undefined,
	onRoleChange: ((next: string) => void) | undefined,
): {
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
	return { handleRoleChange, peopleRows, query, role, roles, setQuery };
}

/**
 * Posture, threats, budget, latency, controls, and profiles sections. The
 * variant split is collapsed so these are simply the metric and policy
 * sections. Extracted so `Dashboard` stays under the function-size lint
 * budget (multi-line JSX prop lines count toward it).
 */
function OverviewSections({
	controls,
	metrics,
	profiles,
	usage,
}: {
	controls: readonly ControlSummary[];
	metrics: ConsumerMetrics;
	profiles: readonly ProfileSummary[];
	usage: UserTokenUsage[];
}) {
	return (
		<>
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
				<UserTokenUsageCard usage={usage} />
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
				<ControlsSection controls={controls} />
			</div>
			<Separator />

			<div className="flex flex-col gap-3">
				<SectionTitle
					description="Strictness profiles and their inbound block thresholds."
					title="Strictness profiles"
				/>
				<ProfilesSection profiles={profiles} />
			</div>
		</>
	);
}

/**
 * People section. The `overview`/`full` variant split is collapsed (Overview
 * merge): this always renders. Escalations render separately in
 * `ActivitySections` on the Overview page, so they are not duplicated here.
 * `Dashboard` keeps its `variant` prop for route compat (header copy only).
 */
function FullVariantSections({
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
			<Separator />

			<PeopleBlock
				onQueryChange={onQueryChange}
				onRoleChange={onRoleChange}
				query={query}
				role={role}
				roles={roles}
				rows={rows}
			/>
		</>
	);
}

/**
 * Dashboard footer: last-update stamp and the audit export links.
 * Extracted so `Dashboard` stays under the function-size lint budget.
 */
function DashboardFooter({ generatedAt }: { generatedAt: string }) {
	return (
		<footer className="flex flex-wrap items-center justify-between gap-4 border-t pt-4">
			<p className="text-muted-foreground text-xs">
				{`Last update ${formatTimestamp(generatedAt)} · refreshes every ${REFRESH_INTERVAL_SECONDS}s`}
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
	);
}

/**
 * Interactive dashboard (security-observability spec): controls and profiles
 * in force, posture, threats by control/category, budget vs limits, latency
 * percentiles, people, versions in force, and live refresh via polling.
 * Escalations and the per-consumer breakdown render separately in
 * `ActivitySections` on the Overview page and are not duplicated here.
 *
 * `initialConsumer` seeds the consumer scope dropdown from the route's
 * `?consumer=` search param (URL is the source of truth: the effect below
 * resyncs local state whenever the route selection changes). `onConsumerChange`
 * reports dropdown changes so the route can navigate to `?consumer=` (or clear
 * it for the aggregate scope); without it the dropdown stays purely local.
 *
 * `initialRole`/`onRoleChange` mirror that pair for the role filter from the
 * route's `?role=` search param (`undefined` means all roles). The role
 * selection filters the People table; escalations render separately in
 * `ActivitySections` on the Overview page. The person search box stays local
 * and is never reflected in the URL.
 */
export function Dashboard({
	initialConsumer,
	initialData,
	initialRole,
	onConsumerChange,
	onRefresh,
	onRoleChange,
	variant = "full",
}: {
	initialConsumer?: string | undefined;
	initialData: DashboardData;
	initialRole?: string | undefined;
	onConsumerChange?: ((next: string) => void) | undefined;
	onRefresh: () => Promise<DashboardData>;
	onRoleChange?: ((next: string) => void) | undefined;
	variant?: DashboardVariant | undefined;
}) {
	const [data, setData] = useState<DashboardData>(initialData);
	const { consumer, handleConsumerChange } = useConsumerScope(initialConsumer, onConsumerChange);
	const { handleRoleChange, peopleRows, query, role, roles, setQuery } = usePeopleScope(
		data,
		initialRole,
		onRoleChange,
	);

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
	const usage = data.userTokenUsage;

	return (
		<main className="mx-auto flex w-full max-w-6xl flex-col gap-8 p-6">
			<DashboardHeader
				consumer={consumer}
				consumerKeys={data.consumerKeys}
				data={data}
				onConsumerChange={handleConsumerChange}
				variant={variant}
			/>

			<TierStatusBanner />

			<p className="text-muted-foreground text-xs">
				{`Live refresh every ${REFRESH_INTERVAL_SECONDS}s · last update ${formatTimestamp(data.generatedAt)}`}
			</p>

			<OverviewSections
				controls={data.policy.controls}
				metrics={metrics}
				profiles={data.policy.profiles}
				usage={usage}
			/>

			<FullVariantSections
				onQueryChange={setQuery}
				onRoleChange={handleRoleChange}
				query={query}
				role={role}
				roles={roles}
				rows={peopleRows}
			/>

			<DashboardFooter generatedAt={data.generatedAt} />
		</main>
	);
}
