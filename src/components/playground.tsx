import { useId } from "react";

import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card.tsx";

export interface GuardHit {
	control: string;
	detail?: string;
	engine: string;
	kind: string;
}

export interface GuardView {
	blockedBy?: string;
	content?: string;
	details?: string[];
	error?: string;
	flagged?: boolean;
	hits?: GuardHit[];
	reasons?: string[];
	verdict?: string;
}

export interface Sample {
	direction: "inbound" | "outbound";
	label: string;
	seam: "chat" | "guard-api" | "mcp-tool";
	text: string;
}

const verdictVariants: Record<string, "default" | "destructive" | "outline" | "secondary"> = {
	allow: "default",
	block: "destructive",
	escalate: "secondary",
	redact: "outline",
};

export function SamplePicker({
	items,
	onPick,
}: {
	items: readonly Sample[];
	onPick: (sample: Sample) => void;
}) {
	return (
		<div className="mt-4 flex flex-wrap gap-2">
			{items.map((sample) => (
				<Button
					key={sample.label}
					onClick={() => onPick(sample)}
					size="sm"
					type="button"
					variant="outline"
				>
					{sample.label}
				</Button>
			))}
		</div>
	);
}

export interface GuardFormProps {
	busy: boolean;
	direction: "inbound" | "outbound";
	onDirectionChange: (direction: "inbound" | "outbound") => void;
	onSeamChange: (seam: "chat" | "guard-api" | "mcp-tool") => void;
	onSubmit: () => void;
	onTextChange: (text: string) => void;
	seam: "chat" | "guard-api" | "mcp-tool";
	text: string;
}

export function GuardForm(props: GuardFormProps) {
	const textId = useId();
	const directionId = useId();
	const seamId = useId();
	return (
		<div>
			<label className="mt-4 block text-sm font-medium" htmlFor={textId}>
				Content to inspect
			</label>
			<textarea
				className="mt-1 h-32 w-full rounded-md border border-gray-300 p-3 font-mono text-sm"
				id={textId}
				onChange={(event) => props.onTextChange(event.target.value)}
				value={props.text}
			/>
			<div className="mt-3 flex items-center gap-3">
				<label className="text-sm font-medium" htmlFor={directionId}>
					Direction
				</label>
				<select
					className="rounded-md border border-gray-300 px-2 py-1 text-sm"
					id={directionId}
					onChange={(event) => {
						const value: unknown = event.target.value;
						if (value === "inbound" || value === "outbound") {
							props.onDirectionChange(value);
						}
					}}
					value={props.direction}
				>
					<option value="inbound">inbound</option>
					<option value="outbound">outbound</option>
				</select>
				<label className="text-sm font-medium" htmlFor={seamId}>
					Seam
				</label>
				<select
					className="rounded-md border border-gray-300 px-2 py-1 text-sm"
					id={seamId}
					onChange={(event) => {
						const value: unknown = event.target.value;
						if (value === "chat" || value === "guard-api" || value === "mcp-tool") {
							props.onSeamChange(value);
						}
					}}
					value={props.seam}
				>
					<option value="chat">chat</option>
					<option value="guard-api">guard-api</option>
					<option value="mcp-tool">mcp-tool</option>
				</select>
				<Button
					disabled={props.busy || props.text.length === 0}
					onClick={props.onSubmit}
					type="button"
				>
					{props.busy ? "Checking…" : "Run guard"}
				</Button>
			</div>
		</div>
	);
}

const engineVariants: Record<string, "default" | "destructive" | "outline" | "secondary"> = {
	feed: "secondary",
	jev: "default",
	pipeline: "outline",
	policy: "outline",
	regex: "secondary",
};

function engineLabel(engine: string): string {
	if (engine === "jev") {
		return "JEV";
	}
	return engine;
}

export function ResultPanel({ result }: { result: GuardView }) {
	return (
		<Card className="mt-6">
			<CardHeader>
				<CardTitle>Guard result</CardTitle>
			</CardHeader>
			<CardContent>
				<div className="flex items-center gap-3">
					<Badge variant={verdictVariants[result.verdict ?? ""] ?? "outline"}>
						{result.verdict ?? result.error ?? "unknown"}
					</Badge>
					{result.blockedBy ? (
						<span className="text-muted-foreground text-sm">blocked by: {result.blockedBy}</span>
					) : null}
					{result.flagged ? <Badge variant="secondary">flagged for review</Badge> : null}
				</div>
				{result.hits && result.hits.length > 0 ? (
					<ul className="mt-3 space-y-1">
						{result.hits.map((hit) => (
							<li
								className="flex flex-wrap items-center gap-2 font-mono text-sm"
								key={`${hit.control}-${hit.kind}-${hit.detail ?? ""}`}
							>
								<Badge variant={engineVariants[hit.engine] ?? "outline"}>
									{engineLabel(hit.engine)}
								</Badge>
								<span>
									{hit.control}: {hit.kind}
								</span>
								{hit.detail ? <span className="text-muted-foreground">{hit.detail}</span> : null}
							</li>
						))}
					</ul>
				) : null}
				{result.reasons && result.reasons.length > 0 ? (
					<div className="mt-3">
						<h2 className="text-muted-foreground text-sm font-semibold uppercase tracking-wide">
							Why this decision
						</h2>
						<ul className="mt-1 list-disc space-y-1 pl-5 font-mono text-sm">
							{result.reasons.map((reason) => (
								<li key={reason}>{reason}</li>
							))}
						</ul>
					</div>
				) : null}
				{result.details && result.details.length > 0 ? (
					<ul className="mt-3 list-disc space-y-1 pl-5 font-mono text-sm">
						{result.details.map((detail) => (
							<li key={detail}>{detail}</li>
						))}
					</ul>
				) : null}
				{result.content !== undefined ? (
					<div className="mt-4">
						<h2 className="text-muted-foreground text-sm font-semibold uppercase tracking-wide">
							Forwarded content
						</h2>
						<pre className="bg-muted mt-1 whitespace-pre-wrap rounded p-3 font-mono text-sm">
							{result.content}
						</pre>
					</div>
				) : null}
			</CardContent>
		</Card>
	);
}
