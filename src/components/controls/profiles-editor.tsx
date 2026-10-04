import { useEffect, useState } from "react";
import { CheckRow } from "#/components/controls/fields.tsx";
import { PROFILE_NAMES, type ProfileName } from "#/components/controls/options.ts";
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
import type { Policy, Profile } from "#/control/policy/schema.ts";

type ThresholdControl = keyof Profile["enabledControls"];
type ThresholdDirection = keyof Profile["thresholds"]["detection"];
type ThresholdKind = keyof Profile["thresholds"]["detection"]["inbound"];

const MAX_THRESHOLD = 1;
const MIN_THRESHOLD = 0;
const THRESHOLD_CONTROLS: readonly ThresholdControl[] = ["detection", "semantic", "signatures"];
const THRESHOLD_DIRECTIONS: readonly ThresholdDirection[] = ["inbound", "outbound"];
const THRESHOLD_KINDS: readonly ThresholdKind[] = ["block", "escalate", "redact"];

interface ProfilesEditorProps {
	draft: Policy;
	onChange: (next: Policy) => void;
}

export function ProfilesEditor({ draft, onChange }: ProfilesEditorProps) {
	return (
		<div className="flex flex-col gap-6">
			{PROFILE_NAMES.map((name) => (
				<ProfileCard
					key={name}
					name={name}
					onChange={(next) => {
						const copy = structuredClone(draft);
						copy.profiles[name] = next;
						onChange(copy);
					}}
					profile={draft.profiles[name]}
				/>
			))}
		</div>
	);
}

function ProfileCard({
	name,
	onChange,
	profile,
}: {
	name: ProfileName;
	onChange: (next: Profile) => void;
	profile: Profile;
}) {
	const rows = THRESHOLD_CONTROLS.flatMap((control) =>
		THRESHOLD_DIRECTIONS.map((direction) => ({ control, direction })),
	);
	return (
		<Card>
			<CardHeader>
				<CardTitle className="capitalize">{name}</CardTitle>
				<CardDescription>Enabled controls and evidence thresholds.</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="flex flex-col gap-4">
					<div className="flex flex-wrap gap-4">
						{THRESHOLD_CONTROLS.map((control) => (
							<CheckRow
								checked={profile.enabledControls[control]}
								key={control}
								label={control}
								onChange={(next) => {
									const copy = structuredClone(profile);
									copy.enabledControls[control] = next;
									onChange(copy);
								}}
							/>
						))}
					</div>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Control</TableHead>
								<TableHead>Direction</TableHead>
								<TableHead className="text-right">Block</TableHead>
								<TableHead className="text-right">Escalate</TableHead>
								<TableHead className="text-right">Redact</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{rows.map(({ control, direction }) => (
								<TableRow key={`${control}-${direction}`}>
									<TableCell className="font-medium">{control}</TableCell>
									<TableCell>{direction}</TableCell>
									{THRESHOLD_KINDS.map((kind) => (
										<TableCell className="text-right" key={kind}>
											<ThresholdInput
												label={`${name} ${control} ${direction} ${kind} threshold`}
												onChange={(next) => {
													const copy = structuredClone(profile);
													copy.thresholds[control][direction][kind] = next;
													onChange(copy);
												}}
												value={profile.thresholds[control][direction][kind]}
											/>
										</TableCell>
									))}
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			</CardContent>
		</Card>
	);
}

function ThresholdInput({
	label,
	onChange,
	value,
}: {
	label: string;
	onChange: (next: number) => void;
	value: number;
}) {
	const [text, setText] = useState(String(value));
	useEffect(() => {
		setText(String(value));
	}, [value]);
	const commit = () => {
		if (text.trim() === "") {
			setText(String(value));
			return;
		}
		const parsed = Number(text);
		if (Number.isNaN(parsed)) {
			setText(String(value));
			return;
		}
		const clamped = Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, parsed));
		if (clamped !== value) {
			onChange(clamped);
		} else if (text !== String(value)) {
			setText(String(value));
		}
	};
	return (
		<input
			aria-label={label}
			autoComplete="off"
			className="w-20 rounded-md border border-input bg-transparent px-2 py-1 text-right text-sm tabular-nums shadow-xs outline-none focus-visible:border-ring"
			inputMode="decimal"
			onBlur={commit}
			onChange={(event) => setText(event.target.value)}
			onKeyDown={(event) => {
				if (event.key === "Enter") {
					event.currentTarget.blur();
				}
			}}
			pattern="[0-9]*[.]?[0-9]*"
			title="Enter a number from 0 to 1"
			type="text"
			value={text}
		/>
	);
}
