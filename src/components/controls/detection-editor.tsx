import { useEffect, useId, useState } from "react";
import { ActionSelect, BufferedInput, CheckRow } from "#/components/controls/fields.tsx";
import {
	type Action,
	BUILTIN_KEYS,
	type BuiltinKey,
	DIRECTIONS,
	type Direction,
	TEXT_INPUT_CLASS,
} from "#/components/controls/options.ts";
import { Button } from "#/components/ui/button.tsx";
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
import {
	type DetectionConfig,
	type DetectionRule,
	type Policy,
	patternComplexityProblem,
} from "#/control/policy/schema.ts";

const DELETE_COUNT = 1;
const MAX_PATTERN_LENGTH = 500;
const MIN_DEFAULT_ACTIONS = 1;
const NEW_RULE_ACTION = "flag";
const NEW_RULE_DIRECTION = "inbound";
const NEW_RULE_KIND = "custom";
const RULE_ID_START = 1;

function ruleIdProblem(id: string, duplicate: boolean): string | null {
	if (id.length === 0) {
		return "Rule id is required.";
	}
	if (duplicate) {
		return "Duplicate rule id.";
	}
	return null;
}

function patternProblem(pattern: string): string | null {
	if (pattern.length === 0) {
		return "Pattern is required.";
	}
	if (pattern.length > MAX_PATTERN_LENGTH) {
		return `Pattern exceeds ${MAX_PATTERN_LENGTH} characters.`;
	}
	const complexity = patternComplexityProblem(pattern);
	if (complexity !== "") {
		return complexity;
	}
	return null;
}

function nextRuleId(rules: readonly DetectionRule[]): string {
	let index = rules.length + RULE_ID_START;
	let candidate = `custom-rule-${index}`;
	while (rules.some((rule) => rule.id === candidate)) {
		index += RULE_ID_START;
		candidate = `custom-rule-${index}`;
	}
	return candidate;
}

interface DetectionEditorProps {
	draft: Policy;
	onChange: (next: Policy) => void;
}

export function DetectionEditor({ draft, onChange }: DetectionEditorProps) {
	const detection = draft.controls.detection;
	const update = (mutate: (copy: Policy) => void): void => {
		const copy = structuredClone(draft);
		mutate(copy);
		onChange(copy);
	};
	return (
		<div className="flex flex-col gap-6">
			<BuiltinsCard
				builtins={detection.builtins}
				onToggle={(key, next) => {
					update((copy) => {
						copy.controls.detection.builtins[key] = next;
					});
				}}
			/>
			<DefaultActionsCard
				actions={detection.defaultActions}
				onAdd={(kind) => {
					update((copy) => {
						copy.controls.detection.defaultActions[kind] = NEW_RULE_ACTION;
					});
				}}
				onRemove={(kind) => {
					update((copy) => {
						const next: Record<string, Action> = {};
						for (const [entryKind, entryAction] of Object.entries(
							copy.controls.detection.defaultActions,
						)) {
							if (entryKind !== kind) {
								next[entryKind] = entryAction;
							}
						}
						copy.controls.detection.defaultActions = next;
					});
				}}
				onUpdate={(kind, next) => {
					update((copy) => {
						copy.controls.detection.defaultActions[kind] = next;
					});
				}}
			/>
			<RulesCard
				onAdd={() => {
					update((copy) => {
						const rules = copy.controls.detection.rules;
						rules.push({
							action: NEW_RULE_ACTION,
							directions: [NEW_RULE_DIRECTION],
							id: nextRuleId(rules),
							kind: NEW_RULE_KIND,
							pattern: "",
						});
					});
				}}
				onRemove={(index) => {
					update((copy) => {
						copy.controls.detection.rules.splice(index, DELETE_COUNT);
					});
				}}
				onRuleChange={(index, next) => {
					update((copy) => {
						copy.controls.detection.rules = copy.controls.detection.rules.map((rule, position) =>
							position === index ? next : rule,
						);
					});
				}}
				rules={detection.rules}
			/>
		</div>
	);
}

function BuiltinsCard({
	builtins,
	onToggle,
}: {
	builtins: DetectionConfig["builtins"];
	onToggle: (key: BuiltinKey, next: boolean) => void;
}) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Built-in detectors</CardTitle>
				<CardDescription>Which deterministic detector families run.</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="flex flex-col gap-2">
					{BUILTIN_KEYS.map((key) => (
						<CheckRow
							checked={builtins[key]}
							key={key}
							label={key}
							onChange={(next) => onToggle(key, next)}
						/>
					))}
				</div>
			</CardContent>
		</Card>
	);
}

function DefaultActionsCard({
	actions,
	onAdd,
	onRemove,
	onUpdate,
}: {
	actions: DetectionConfig["defaultActions"];
	onAdd: (kind: string) => void;
	onRemove: (kind: string) => void;
	onUpdate: (kind: string, next: Action) => void;
}) {
	const kindId = useId();
	const [kind, setKind] = useState("");
	const [error, setError] = useState<string | null>(null);
	const entries = Object.entries(actions);
	const handleAdd = (): void => {
		const trimmed = kind.trim();
		if (trimmed.length === 0) {
			setError("Kind is required.");
			return;
		}
		if (actions[trimmed] !== undefined) {
			setError(`Kind "${trimmed}" already exists.`);
			return;
		}
		onAdd(trimmed);
		setKind("");
		setError(null);
	};
	return (
		<Card>
			<CardHeader>
				<CardTitle>Default actions</CardTitle>
				<CardDescription>Fallback action per detector kind.</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="flex flex-col gap-3">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Kind</TableHead>
								<TableHead>Action</TableHead>
								<TableHead>
									<span className="sr-only">Remove</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{entries.map(([entryKind, action]) => (
								<TableRow key={entryKind}>
									<TableCell className="font-medium">{entryKind}</TableCell>
									<TableCell>
										<ActionSelect
											label={`Default action for ${entryKind}`}
											onChange={(next) => onUpdate(entryKind, next)}
											value={action}
										/>
									</TableCell>
									<TableCell>
										<Button
											disabled={entries.length <= MIN_DEFAULT_ACTIONS}
											onClick={() => onRemove(entryKind)}
											size="sm"
											type="button"
											variant="destructive"
										>
											Remove
										</Button>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
					<div className="flex flex-wrap items-center gap-2">
						<label className="text-sm font-medium" htmlFor={kindId}>
							New kind
						</label>
						<input
							className={`${TEXT_INPUT_CLASS} w-48`}
							id={kindId}
							onChange={(event) => setKind(event.target.value)}
							placeholder="e.g. custom"
							value={kind}
						/>
						<Button onClick={handleAdd} size="sm" type="button" variant="outline">
							Add kind
						</Button>
					</div>
					{error !== null ? (
						<p className="text-destructive text-sm" role="alert">
							{error}
						</p>
					) : null}
				</div>
			</CardContent>
		</Card>
	);
}

function RulesCard({
	onAdd,
	onRemove,
	onRuleChange,
	rules,
}: {
	onAdd: () => void;
	onRemove: (index: number) => void;
	onRuleChange: (index: number, next: DetectionRule) => void;
	rules: readonly DetectionRule[];
}) {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const rule of rules) {
		if (seen.has(rule.id)) {
			duplicates.add(rule.id);
		}
		seen.add(rule.id);
	}
	return (
		<Card>
			<CardHeader>
				<CardTitle>Custom rules</CardTitle>
				<CardDescription>Regex detection rules with per-rule actions.</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="flex flex-col gap-3">
					{rules.length === 0 ? (
						<p className="text-muted-foreground text-sm">No custom rules yet.</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Rule ID</TableHead>
									<TableHead>Kind</TableHead>
									<TableHead>Pattern</TableHead>
									<TableHead>Directions</TableHead>
									<TableHead>Action</TableHead>
									<TableHead>
										<span className="sr-only">Remove</span>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{rules.map((rule, index) => (
									<RuleRow
										duplicate={rule.id.length > 0 && duplicates.has(rule.id)}
										key={rule.id}
										onChange={(next) => onRuleChange(index, next)}
										onRemove={() => onRemove(index)}
										rule={rule}
									/>
								))}
							</TableBody>
						</Table>
					)}
					<div>
						<Button onClick={onAdd} size="sm" type="button" variant="outline">
							Add rule
						</Button>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}

function RuleRow({
	duplicate,
	onChange,
	onRemove,
	rule,
}: {
	duplicate: boolean;
	onChange: (next: DetectionRule) => void;
	onRemove: () => void;
	rule: DetectionRule;
}) {
	const rowId = useId();
	const toggleDirection = (direction: Direction): void => {
		const next = rule.directions.includes(direction)
			? rule.directions.filter((entry) => entry !== direction)
			: [...rule.directions, direction];
		if (next.length === 0) {
			return;
		}
		onChange({ ...rule, directions: next });
	};
	return (
		<TableRow>
			<TableCell>
				<RuleIdCell
					duplicate={duplicate}
					id={rule.id}
					onCommit={(next) => onChange({ ...rule, id: next })}
				/>
			</TableCell>
			<TableCell>
				<BufferedInput
					ariaLabel="Rule kind"
					className={`${TEXT_INPUT_CLASS} w-28`}
					onCommit={(next) => onChange({ ...rule, kind: next })}
					value={rule.kind}
				/>
			</TableCell>
			<TableCell>
				<RulePatternCell
					onCommit={(next) => onChange({ ...rule, pattern: next })}
					pattern={rule.pattern}
				/>
			</TableCell>
			<TableCell>
				<DirectionToggles onToggle={toggleDirection} rowId={rowId} selected={rule.directions} />
			</TableCell>
			<TableCell>
				<ActionSelect
					label={`Action for rule ${rule.id}`}
					onChange={(next) => onChange({ ...rule, action: next })}
					value={rule.action}
				/>
			</TableCell>
			<TableCell>
				<Button onClick={onRemove} size="sm" type="button" variant="destructive">
					Remove
				</Button>
			</TableCell>
		</TableRow>
	);
}

function RuleIdCell({
	duplicate,
	id,
	onCommit,
}: {
	duplicate: boolean;
	id: string;
	onCommit: (next: string) => void;
}) {
	const error = ruleIdProblem(id, duplicate);
	return (
		<div className="flex flex-col gap-1">
			<BufferedInput
				ariaLabel="Rule id"
				className={`${TEXT_INPUT_CLASS} w-32`}
				onCommit={onCommit}
				value={id}
			/>
			{error !== null ? (
				<span className="text-destructive text-xs" role="alert">
					{error}
				</span>
			) : null}
		</div>
	);
}

function RulePatternCell({
	onCommit,
	pattern,
}: {
	onCommit: (next: string) => void;
	pattern: string;
}) {
	const [text, setText] = useState(pattern);
	useEffect(() => {
		setText(pattern);
	}, [pattern]);
	const error = patternProblem(text);
	return (
		<div className="flex flex-col gap-1">
			<input
				aria-label="Rule pattern"
				className={`${TEXT_INPUT_CLASS} w-56 font-mono text-xs`}
				onBlur={() => {
					if (text !== pattern) {
						onCommit(text);
					}
				}}
				onChange={(event) => setText(event.target.value)}
				spellCheck={false}
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

function DirectionToggles({
	onToggle,
	rowId,
	selected,
}: {
	onToggle: (direction: Direction) => void;
	rowId: string;
	selected: readonly Direction[];
}) {
	return (
		<div className="flex flex-col gap-1">
			{DIRECTIONS.map((direction) => {
				const boxId = `${rowId}-${direction}`;
				return (
					<div className="flex items-center gap-1" key={direction}>
						<input
							checked={selected.includes(direction)}
							className="size-4"
							id={boxId}
							onChange={() => onToggle(direction)}
							type="checkbox"
						/>
						<label className="text-xs" htmlFor={boxId}>
							{direction}
						</label>
					</div>
				);
			})}
		</div>
	);
}
