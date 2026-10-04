import { CheckRow, ProfileSelect, VerdictSelect } from "#/components/controls/fields.tsx";
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
import type { Policy } from "#/control/policy/schema.ts";

interface GeneralFormProps {
	draft: Policy;
	onChange: (next: Policy) => void;
}

export function GeneralForm({ draft, onChange }: GeneralFormProps) {
	const update = (mutate: (copy: Policy) => void): void => {
		const copy = structuredClone(draft);
		mutate(copy);
		onChange(copy);
	};
	return (
		<div className="flex flex-col gap-6">
			<Card>
				<CardHeader>
					<CardTitle>General</CardTitle>
					<CardDescription>Master switches and default verdict behavior.</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="flex flex-col gap-4">
						<div className="flex flex-col gap-2">
							<CheckRow
								checked={draft.controls.enabled}
								label="Controls enabled"
								onChange={(next) => {
									update((copy) => {
										copy.controls.enabled = next;
									});
								}}
							/>
							<CheckRow
								checked={draft.controls.redaction.enabled}
								label="Redaction enabled"
								onChange={(next) => {
									update((copy) => {
										copy.controls.redaction.enabled = next;
									});
								}}
							/>
							<CheckRow
								checked={draft.controls.signatures.enabled}
								label="Signatures enabled"
								onChange={(next) => {
									update((copy) => {
										copy.controls.signatures.enabled = next;
									});
								}}
							/>
						</div>
						<div className="flex flex-wrap gap-4">
							<div className="flex flex-col gap-1">
								<span className="text-sm font-medium">Failure verdict</span>
								<VerdictSelect
									label="Failure verdict"
									onChange={(next) => {
										update((copy) => {
											copy.defaults.failureVerdict = next;
										});
									}}
									value={draft.defaults.failureVerdict}
								/>
							</div>
							<div className="flex flex-col gap-1">
								<span className="text-sm font-medium">Default profile</span>
								<ProfileSelect
									label="Default profile"
									onChange={(next) => {
										update((copy) => {
											copy.defaults.profile = next;
										});
									}}
									value={draft.defaults.profile}
								/>
							</div>
						</div>
					</div>
				</CardContent>
			</Card>
			<Card>
				<CardHeader>
					<CardTitle>Groups</CardTitle>
					<CardDescription>Strictness profile assignment per user group.</CardDescription>
				</CardHeader>
				<CardContent>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Group</TableHead>
								<TableHead>Profile</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{Object.entries(draft.groups).map(([name, group]) => (
								<TableRow key={name}>
									<TableCell className="font-medium">{name}</TableCell>
									<TableCell>
										<ProfileSelect
											label={`Profile for group ${name}`}
											onChange={(next) => {
												update((copy) => {
													const entry = copy.groups[name];
													if (entry !== undefined) {
														entry.profile = next;
													}
												});
											}}
											value={group.profile}
										/>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</CardContent>
			</Card>
		</div>
	);
}
