import type { DetectionView, GuardResultView, MatchView } from "#/lib/guard-result.ts";

export interface Sample {
	label: string;
	surface: "output" | "prompt" | "tool-call";
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

export function DetectionList({ detections }: { detections: DetectionView[] }) {
	if (detections.length === 0) {
		return null;
	}
	return (
		<div className="mt-4">
			<h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Detections</h2>
			<ul className="mt-1 space-y-1">
				{detections.map((detection) => (
					<li className="font-mono text-sm" key={`${detection.detectorId}-${detection.value}`}>
						<span className="font-semibold">{detection.type}</span> ({detection.detectorId},{" "}
						{detection.validated ? "validated" : `suspect ${detection.confidence}`}):{" "}
						{detection.value}
					</li>
				))}
			</ul>
		</div>
	);
}

export function MatchList({ matches }: { matches: MatchView[] }) {
	if (matches.length === 0) {
		return null;
	}
	return (
		<div className="mt-4">
			<h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
				Signature matches
			</h2>
			<ul className="mt-1 space-y-1">
				{matches.map((match) => (
					<li className="font-mono text-sm" key={`${match.signatureId}-${match.value}`}>
						<span className="font-semibold">{match.signatureId}</span> [{match.severity}/
						{match.kind}] from {match.source}: {match.value}
					</li>
				))}
			</ul>
		</div>
	);
}

export function ResultPanel({ result }: { result: GuardResultView }) {
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
				{result.reason ? <span className="text-sm text-gray-600">{result.reason}</span> : null}
				{result.feedVersion ? (
					<span className="text-xs text-gray-500">feed {result.feedVersion}</span>
				) : null}
			</div>
			{result.redactedText !== undefined ? (
				<div className="mt-4">
					<h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
						Text after redaction (what the semantic tier would see)
					</h2>
					<pre className="mt-1 whitespace-pre-wrap rounded bg-gray-50 p-3 font-mono text-sm">
						{result.redactedText}
					</pre>
				</div>
			) : null}
			<DetectionList detections={result.detections} />
			<MatchList matches={result.matches} />
		</div>
	);
}
