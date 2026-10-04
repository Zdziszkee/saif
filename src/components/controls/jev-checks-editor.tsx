import { useEffect, useId, useState } from "react";
import { TEXT_INPUT_CLASS } from "#/components/controls/options.ts";
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
import type { SemanticConfig } from "#/control/semantic/config.ts";
import type { SemanticCheck, ThresholdLadder } from "#/control/semantic/types.ts";

const MAX_THRESHOLD = 1;
const MIN_THRESHOLD = 0;
const THRESHOLD_ERROR = "0–1 required";

type LadderKey = "block" | "flag";
type ThresholdDirection = "inbound" | "outbound";

function thresholdValue(
	check: SemanticCheck,
	direction: ThresholdDirection,
	key: LadderKey,
): number | undefined {
	return check.thresholds[direction]?.[key];
}

function setThreshold(
	check: SemanticCheck,
	direction: ThresholdDirection,
	key: LadderKey,
	value: number | undefined,
): void {
	const existing = check.thresholds[direction];
	if (value === undefined) {
		if (existing === undefined) {
			return;
		}
		const next: ThresholdLadder = {};
		if (key !== "block") {
			next.block = existing.block;
		}
		if (key !== "flag") {
			next.flag = existing.flag;
		}
		next.redact = existing.redact;
		if (next.block === undefined && next.flag === undefined && next.redact === undefined) {
			check.thresholds[direction] = undefined;
		} else {
			check.thresholds[direction] = next;
		}
		return;
	}
	const base: ThresholdLadder = { ...(existing ?? {}) };
	if (key === "block") {
		base.block = value;
	} else {
		base.flag = value;
	}
	check.thresholds[direction] = base;
}

function thresholdError(text: string): string | null {
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		return null;
	}
	const numeric = Number(trimmed);
	if (Number.isNaN(numeric) || numeric < MIN_THRESHOLD || numeric > MAX_THRESHOLD) {
		return THRESHOLD_ERROR;
	}
	return null;
}

function ThresholdCell({
	label,
	onCommit,
	value,
}: {
	label: string;
	onCommit: (next: number | undefined) => void;
	value: number | undefined;
}) {
	const display = value === undefined ? "" : String(value);
	const [text, setText] = useState(display);
	useEffect(() => {
		setText(display);
	}, [display]);
	const error = thresholdError(text);
	const commit = (): void => {
		if (thresholdError(text) !== null) {
			return;
		}
		const trimmed = text.trim();
		if (trimmed.length === 0) {
			if (value !== undefined) {
				onCommit(undefined);
			}
			return;
		}
		const next = Number(trimmed);
		if (value !== next) {
			onCommit(next);
		}
	};
	return (
		<div className="flex flex-col gap-1">
			<input
				aria-label={label}
				className={`${TEXT_INPUT_CLASS} w-24`}
				inputMode="decimal"
				onBlur={commit}
				onChange={(event) => setText(event.target.value)}
				value={text}
			/>
			{error !== null ? (
				<span className="text-destructive text-xs" role="alert">
					{error}
				</span>
			) : null}
		</div>
	);
}

function JevCheckRow({
	check,
	onEnabledChange,
	onThresholdChange,
}: {
	check: SemanticCheck;
	onEnabledChange: (next: boolean) => void;
	onThresholdChange: (
		direction: ThresholdDirection,
		key: LadderKey,
		value: number | undefined,
	) => void;
}) {
	const rowId = useId();
	const enabledId = `${rowId}-enabled`;
	return (
		<TableRow>
			<TableCell>
				<div className="font-medium">{check.id}</div>
				<div className="text-muted-foreground max-w-64 truncate text-xs" title={check.instructions}>
					{check.instructions}
				</div>
			</TableCell>
			<TableCell>
				<div className="flex items-center gap-2">
					<input
						checked={check.enabled}
						className="size-4"
						id={enabledId}
						onChange={(event) => onEnabledChange(event.target.checked)}
						type="checkbox"
					/>
					<label className="sr-only" htmlFor={enabledId}>
						{`Enable ${check.id}`}
					</label>
				</div>
			</TableCell>
			<TableCell>
				<ThresholdCell
					label={`Inbound block threshold for ${check.id}`}
					onCommit={(next) => onThresholdChange("inbound", "block", next)}
					value={thresholdValue(check, "inbound", "block")}
				/>
			</TableCell>
			<TableCell>
				<ThresholdCell
					label={`Inbound flag threshold for ${check.id}`}
					onCommit={(next) => onThresholdChange("inbound", "flag", next)}
					value={thresholdValue(check, "inbound", "flag")}
				/>
			</TableCell>
			<TableCell>
				<ThresholdCell
					label={`Outbound block threshold for ${check.id}`}
					onCommit={(next) => onThresholdChange("outbound", "block", next)}
					value={thresholdValue(check, "outbound", "block")}
				/>
			</TableCell>
			<TableCell>
				<ThresholdCell
					label={`Outbound flag threshold for ${check.id}`}
					onCommit={(next) => onThresholdChange("outbound", "flag", next)}
					value={thresholdValue(check, "outbound", "flag")}
				/>
			</TableCell>
		</TableRow>
	);
}

export function JevChecksEditor({
	draft,
	onChange,
}: {
	draft: SemanticConfig;
	onChange: (next: SemanticConfig) => void;
}) {
	const update = (mutate: (copy: SemanticConfig) => void): void => {
		const copy = structuredClone(draft);
		mutate(copy);
		onChange(copy);
	};
	return (
		<Card>
			<CardHeader>
				<CardTitle>JEV decision-model checks</CardTitle>
				<CardDescription>
					Which binary checks run each decide() round trip and their per-direction thresholds.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Check</TableHead>
							<TableHead>Enabled</TableHead>
							<TableHead>Inbound block</TableHead>
							<TableHead>Inbound flag</TableHead>
							<TableHead>Outbound block</TableHead>
							<TableHead>Outbound flag</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{draft.checks.map((check, index) => (
							<JevCheckRow
								check={check}
								key={check.id}
								onEnabledChange={(next) => {
									update((copy) => {
										const target = copy.checks[index];
										if (target !== undefined) {
											target.enabled = next;
										}
									});
								}}
								onThresholdChange={(direction, key, value) => {
									update((copy) => {
										const target = copy.checks[index];
										if (target !== undefined) {
											setThreshold(target, direction, key, value);
										}
									});
								}}
							/>
						))}
					</TableBody>
				</Table>
			</CardContent>
		</Card>
	);
}
