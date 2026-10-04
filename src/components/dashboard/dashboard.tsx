import { useCallback, useEffect, useMemo, useState } from "react";
import {
	BudgetSection,
	LatencySection,
	PostureSection,
	ThreatsSection,
} from "#/components/dashboard/metric-sections.tsx";
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
import { ALL_CONSUMERS, type DashboardData } from "#/dashboard/types.ts";

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
 */
export function Dashboard({
	initialConsumer,
	initialData,
	onConsumerChange,
	onRefresh,
}: {
	initialConsumer?: string | undefined;
	initialData: DashboardData;
	onConsumerChange?: ((next: string) => void) | undefined;
	onRefresh: () => Promise<DashboardData>;
}) {
	const { consumer, handleConsumerChange } = useConsumerScope(initialConsumer, onConsumerChange);
	const [data, setData] = useState<DashboardData>(initialData);

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
	const escalations = useMemo(() => selectEscalations(data, consumer), [data, consumer]);

	return (
		<main className="mx-auto flex w-full max-w-6xl flex-col gap-8 p-6">
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
					<ConsumerSelect
						consumerKeys={data.consumerKeys}
						onChange={handleConsumerChange}
						value={consumer}
					/>
					<ThemeSwitcher />
				</div>
			</header>

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
