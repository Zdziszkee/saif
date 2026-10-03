import { useId } from "react";

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

const verdictStyles: Record<string, string> = {
	allow: "bg-emerald-100 text-emerald-800",
	block: "bg-red-100 text-red-800",
	escalate: "bg-amber-100 text-amber-800",
	redact: "bg-sky-100 text-sky-800",
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
				<button
					className="rounded-full border border-gray-300 px-3 py-1 text-sm hover:bg-gray-100"
					key={sample.label}
					onClick={() => onPick(sample)}
					type="button"
				>
					{sample.label}
				</button>
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
					onChange={(event) =>
						props.onDirectionChange(event.target.value as "inbound" | "outbound")
					}
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
					onChange={(event) =>
						props.onSeamChange(event.target.value as "chat" | "guard-api" | "mcp-tool")
					}
					value={props.seam}
				>
					<option value="chat">chat</option>
					<option value="guard-api">guard-api</option>
					<option value="mcp-tool">mcp-tool</option>
				</select>
				<button
					className="rounded-md bg-gray-900 px-4 py-2 text-sm text-white disabled:opacity-50"
					disabled={props.busy || props.text.length === 0}
					onClick={props.onSubmit}
					type="button"
				>
					{props.busy ? "Checking…" : "Run guard"}
				</button>
			</div>
		</div>
	);
}

const engineStyles: Record<string, string> = {
	feed: "bg-amber-100 text-amber-800",
	jev: "bg-violet-100 text-violet-800",
	policy: "bg-gray-100 text-gray-700",
	regex: "bg-sky-100 text-sky-800",
};

function engineLabel(engine: string): string {
	if (engine === "jev") {
		return "JEV";
	}
	return engine;
}

export function ResultPanel({ result }: { result: GuardView }) {
	return (
		<div className="mt-6 rounded-md border border-gray-200 p-4">
			<div className="flex items-center gap-3">
				<span
					className={`rounded-full px-3 py-1 text-sm font-semibold ${verdictStyles[result.verdict ?? ""] ?? "bg-gray-100"}`}
				>
					{result.verdict ?? result.error ?? "unknown"}
				</span>
				{result.blockedBy ? (
					<span className="text-sm text-gray-600">blocked by: {result.blockedBy}</span>
				) : null}
				{result.flagged ? (
					<span className="rounded-full bg-amber-100 px-3 py-1 text-sm text-amber-800">
						flagged for review
					</span>
				) : null}
			</div>
			{result.hits && result.hits.length > 0 ? (
				<ul className="mt-3 space-y-1">
					{result.hits.map((hit) => (
						<li
							className="flex flex-wrap items-center gap-2 font-mono text-sm"
							key={`${hit.control}-${hit.kind}-${hit.detail ?? ""}`}
						>
							<span
								className={`rounded-full px-2 py-0.5 text-xs font-semibold ${engineStyles[hit.engine] ?? "bg-gray-100"}`}
							>
								{engineLabel(hit.engine)}
							</span>
							<span className="text-gray-700">
								{hit.control}: {hit.kind}
							</span>
							{hit.detail ? <span className="text-gray-500">{hit.detail}</span> : null}
						</li>
					))}
				</ul>
			) : null}
			{result.reasons && result.reasons.length > 0 ? (
				<div className="mt-3">
					<h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
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
					<h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
						Forwarded content
					</h2>
					<pre className="mt-1 whitespace-pre-wrap rounded bg-gray-50 p-3 font-mono text-sm">
						{result.content}
					</pre>
				</div>
			) : null}
		</div>
	);
}
