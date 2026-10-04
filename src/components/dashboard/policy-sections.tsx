import { Badge } from "#/components/ui/badge.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "#/components/ui/table.tsx";
import { formatTimestamp } from "#/dashboard/format.ts";
import type { ControlSummary, EscalationRow, ProfileSummary } from "#/dashboard/types.ts";

/** Muted empty state shown in place of an empty table body. */
function EmptyRows() {
	return <p className="text-muted-foreground text-sm">No activity in this window</p>;
}

function ControlBadge({ enabled }: { enabled: boolean }) {
	return <Badge variant={enabled ? "default" : "outline"}>{enabled ? "active" : "off"}</Badge>;
}

/** Configured controls in force (spec: controls overview). */
export function ControlsSection({ controls }: { controls: readonly ControlSummary[] }) {
	const hasRows = controls.length > 0;
	return (
		<section aria-label="Controls in force">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Control</TableHead>
						<TableHead>Tier</TableHead>
						<TableHead>Status</TableHead>
						<TableHead>Detail</TableHead>
					</TableRow>
				</TableHeader>
				{hasRows ? (
					<TableBody>
						{controls.map((control) => (
							<TableRow key={control.id}>
								<TableCell className="font-medium">{control.id}</TableCell>
								<TableCell>{control.tier}</TableCell>
								<TableCell>
									<ControlBadge enabled={control.enabled} />
								</TableCell>
								<TableCell className="text-muted-foreground">{control.detail}</TableCell>
							</TableRow>
						))}
					</TableBody>
				) : null}
			</Table>
			{hasRows ? null : <EmptyRows />}
		</section>
	);
}

function EnabledFlags({ profile }: { profile: ProfileSummary }) {
	const flags = [
		profile.enabled.detection ? "detection" : null,
		profile.enabled.semantic ? "semantic" : null,
		profile.enabled.signatures ? "signatures" : null,
	].filter((flag) => flag !== null);
	return <span className="text-muted-foreground">{flags.join(", ") || "none"}</span>;
}

/** Strictness profiles in force with their inbound block thresholds. */
export function ProfilesSection({ profiles }: { profiles: readonly ProfileSummary[] }) {
	const hasRows = profiles.length > 0;
	return (
		<section aria-label="Strictness profiles">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Profile</TableHead>
						<TableHead>Controls enabled</TableHead>
						<TableHead className="text-right">Detection block</TableHead>
						<TableHead className="text-right">Semantic block</TableHead>
						<TableHead className="text-right">Signatures block</TableHead>
					</TableRow>
				</TableHeader>
				{hasRows ? (
					<TableBody>
						{profiles.map((profile) => (
							<TableRow key={profile.name}>
								<TableCell className="font-medium">{profile.name}</TableCell>
								<TableCell>
									<EnabledFlags profile={profile} />
								</TableCell>
								<TableCell className="text-right tabular-nums">
									{profile.blockThresholds.detection.inbound}
								</TableCell>
								<TableCell className="text-right tabular-nums">
									{profile.blockThresholds.semantic.inbound}
								</TableCell>
								<TableCell className="text-right tabular-nums">
									{profile.blockThresholds.signatures.inbound}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				) : null}
			</Table>
			{hasRows ? null : <EmptyRows />}
		</section>
	);
}

/** Recent escalations awaiting review (spec: escalation queue). */
export function EscalationsSection({ rows }: { rows: readonly EscalationRow[] }) {
	const hasRows = rows.length > 0;
	return (
		<section aria-label="Escalations awaiting review">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>When</TableHead>
						<TableHead>Consumer</TableHead>
						<TableHead>User</TableHead>
						<TableHead>Subject</TableHead>
						<TableHead>Seam</TableHead>
						<TableHead>Direction</TableHead>
						<TableHead>Reason</TableHead>
					</TableRow>
				</TableHeader>
				{hasRows ? (
					<TableBody>
						{rows.map((row) => (
							<TableRow key={row.id}>
								<TableCell className="tabular-nums">{formatTimestamp(row.timestamp)}</TableCell>
								<TableCell className="font-medium">{row.consumerKey}</TableCell>
								<TableCell className="font-medium">{row.userId ?? "—"}</TableCell>
								<TableCell className="font-medium">{row.subject}</TableCell>
								<TableCell>{row.seam}</TableCell>
								<TableCell>{row.direction}</TableCell>
								<TableCell className="text-muted-foreground">{row.reason}</TableCell>
							</TableRow>
						))}
					</TableBody>
				) : null}
			</Table>
			{hasRows ? null : <EmptyRows />}
		</section>
	);
}
