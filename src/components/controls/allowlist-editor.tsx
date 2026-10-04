import { useId, useState } from "react";
import { BufferedInput } from "#/components/controls/fields.tsx";
import { TEXT_INPUT_CLASS } from "#/components/controls/options.ts";
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
import type { Policy } from "#/control/policy/schema.ts";

type AllowlistModel = Policy["controls"]["allowlist"]["models"][number];

const MIN_MODELS = 1;

function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

interface AllowlistEditorProps {
	draft: Policy;
	onChange: (next: Policy) => void;
}

export function AllowlistEditor({ draft, onChange }: AllowlistEditorProps) {
	const models = draft.controls.allowlist.models;
	const updateModels = (next: AllowlistModel[]): void => {
		const copy = structuredClone(draft);
		copy.controls.allowlist.models = next;
		onChange(copy);
	};
	return (
		<div className="flex flex-col gap-6">
			<ModelsCard
				models={models}
				onModelChange={(index, next) => {
					updateModels(models.map((model, position) => (position === index ? next : model)));
				}}
				onModelRemove={(index) => {
					if (models.length > MIN_MODELS) {
						updateModels(models.filter((_model, position) => position !== index));
					}
				}}
			/>
			<AddModelCard
				models={models}
				onAdd={(name, endpoint) => {
					const copy = structuredClone(draft);
					if (endpoint.length > 0) {
						copy.controls.allowlist.models.push({ endpoint, name });
					} else {
						copy.controls.allowlist.models.push({ name });
					}
					onChange(copy);
				}}
			/>
		</div>
	);
}

function ModelsCard({
	models,
	onModelChange,
	onModelRemove,
}: {
	models: readonly AllowlistModel[];
	onModelChange: (index: number, next: AllowlistModel) => void;
	onModelRemove: (index: number) => void;
}) {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const model of models) {
		if (seen.has(model.name)) {
			duplicates.add(model.name);
		}
		seen.add(model.name);
	}
	return (
		<Card>
			<CardHeader>
				<CardTitle>Allowed models</CardTitle>
				<CardDescription>Permitted LLM models and their endpoints.</CardDescription>
			</CardHeader>
			<CardContent>
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Name</TableHead>
							<TableHead>Endpoint</TableHead>
							<TableHead>
								<span className="sr-only">Remove</span>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{models.map((model, index) => (
							<ModelRow
								duplicate={model.name.length > 0 && duplicates.has(model.name)}
								key={model.name}
								model={model}
								onChange={(next) => onModelChange(index, next)}
								onRemove={() => onModelRemove(index)}
								removable={models.length > MIN_MODELS}
							/>
						))}
					</TableBody>
				</Table>
			</CardContent>
		</Card>
	);
}

function modelNameProblem(name: string, duplicate: boolean): string | null {
	if (name.trim().length === 0) {
		return "Model name is required.";
	}
	if (duplicate) {
		return "Duplicate model name.";
	}
	return null;
}

function ModelRow({
	duplicate,
	model,
	onChange,
	onRemove,
	removable,
}: {
	duplicate: boolean;
	model: AllowlistModel;
	onChange: (next: AllowlistModel) => void;
	onRemove: () => void;
	removable: boolean;
}) {
	const endpoint = model.endpoint ?? "";
	const nameError = modelNameProblem(model.name, duplicate);
	const endpointError =
		endpoint.length > 0 && !isHttpUrl(endpoint) ? "Endpoint must be an http(s) URL." : null;
	return (
		<TableRow>
			<TableCell>
				<div className="flex flex-col gap-1">
					<BufferedInput
						ariaLabel="Model name"
						className={`${TEXT_INPUT_CLASS} w-40`}
						onCommit={(next) => {
							const trimmed = next.trim();
							if (trimmed !== model.name) {
								onChange({ ...model, name: trimmed });
							}
						}}
						value={model.name}
					/>
					{nameError !== null ? (
						<span className="text-destructive text-xs" role="alert">
							{nameError}
						</span>
					) : null}
				</div>
			</TableCell>
			<TableCell>
				<div className="flex flex-col gap-1">
					<BufferedInput
						ariaLabel="Model endpoint"
						className={`${TEXT_INPUT_CLASS} w-64 font-mono text-xs`}
						onCommit={(next) => {
							const trimmed = next.trim();
							if (trimmed === endpoint) {
								return;
							}
							if (trimmed.length === 0) {
								onChange({ name: model.name });
							} else {
								onChange({ endpoint: trimmed, name: model.name });
							}
						}}
						placeholder="https://api.example.com/v1"
						spellCheck={false}
						value={endpoint}
					/>
					{endpointError !== null ? (
						<span className="text-destructive text-xs" role="alert">
							{endpointError}
						</span>
					) : null}
				</div>
			</TableCell>
			<TableCell>
				<Button
					disabled={!removable}
					onClick={onRemove}
					size="sm"
					type="button"
					variant="destructive"
				>
					Remove
				</Button>
			</TableCell>
		</TableRow>
	);
}

function AddModelCard({
	models,
	onAdd,
}: {
	models: readonly AllowlistModel[];
	onAdd: (name: string, endpoint: string) => void;
}) {
	const endpointId = useId();
	const nameId = useId();
	const [endpoint, setEndpoint] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [name, setName] = useState("");
	const handleAdd = (): void => {
		const trimmedName = name.trim();
		if (trimmedName.length === 0) {
			setError("Model name is required.");
			return;
		}
		if (models.some((model) => model.name === trimmedName)) {
			setError(`Model "${trimmedName}" already exists.`);
			return;
		}
		const trimmedEndpoint = endpoint.trim();
		if (trimmedEndpoint.length > 0 && !isHttpUrl(trimmedEndpoint)) {
			setError("Endpoint must be an http(s) URL.");
			return;
		}
		onAdd(trimmedName, trimmedEndpoint);
		setEndpoint("");
		setError(null);
		setName("");
	};
	return (
		<Card>
			<CardHeader>
				<CardTitle>Add model</CardTitle>
				<CardDescription>Endpoint is optional; name must be unique.</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="flex flex-col gap-3">
					<div className="flex flex-wrap items-end gap-2">
						<div className="flex flex-col gap-1">
							<label className="text-sm font-medium" htmlFor={nameId}>
								Name
							</label>
							<input
								className={`${TEXT_INPUT_CLASS} w-40`}
								id={nameId}
								onChange={(event) => setName(event.target.value)}
								value={name}
							/>
						</div>
						<div className="flex flex-col gap-1">
							<label className="text-sm font-medium" htmlFor={endpointId}>
								Endpoint
							</label>
							<input
								className={`${TEXT_INPUT_CLASS} w-64 font-mono text-xs`}
								id={endpointId}
								onChange={(event) => setEndpoint(event.target.value)}
								placeholder="https://api.example.com/v1"
								spellCheck={false}
								value={endpoint}
							/>
						</div>
						<Button onClick={handleAdd} size="sm" type="button" variant="outline">
							Add model
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
