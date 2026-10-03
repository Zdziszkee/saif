import { type Detection, type DetectionKind, detectSensitive } from "#/control/detectors.ts";
import {
	defaultFirstLayerPolicy,
	type FirstLayerPolicy,
	resolveDeterministicAction,
	resolveSignatureAction,
	surfaceDirection,
	type Verdict,
	worstVerdict,
} from "#/control/policy.ts";
import { redactSpans } from "#/control/redact.ts";
import { matchSignatures, type SignatureFeed, type SignatureMatch } from "#/control/signatures.ts";
import { type PiiVault, tokenizeSpans } from "#/control/vault.ts";

export type AnonymizationMode = "placeholder" | "tokenize";

export interface FilterInput {
	surface: "output" | "prompt" | "tool-call";
	text: string;
}

export interface FilterOptions {
	anonymization?: AnonymizationMode;
	feed: SignatureFeed;
	policy?: FirstLayerPolicy;
	vault?: PiiVault;
}

export interface FilterResult {
	detections: Detection[];
	feedVersion: string;
	matches: SignatureMatch[];
	redactedText: string;
	verdict: Verdict;
}

export function filterContent(input: FilterInput, options: FilterOptions): FilterResult {
	const policy = options.policy ?? defaultFirstLayerPolicy;
	const direction = surfaceDirection(input.surface);

	const matches = policy.signatures.enabled
		? matchSignatures(input.text, options.feed.signatures)
		: [];
	const rawDetections = policy.deterministic.enabled ? detectSensitive(input.text) : [];
	const detections = rawDetections.filter(
		(detection) => detection.confidence >= policy.deterministic.minConfidence,
	);

	const redactKinds = new Set<DetectionKind>();
	const verdicts: Verdict[] = [];

	for (const match of matches) {
		verdicts.push(resolveSignatureAction(policy, match.severity, match.action));
	}

	for (const detection of detections) {
		const action = resolveDeterministicAction(policy, detection, direction);
		verdicts.push(action);
		if (action === "redact") {
			redactKinds.add(detection.kind);
		}
	}

	const redactTargets = detections.filter((detection) => redactKinds.has(detection.kind));
	let redactedText = input.text;
	if (redactTargets.length > 0) {
		redactedText =
			options.anonymization === "tokenize" && options.vault !== undefined
				? tokenizeSpans(input.text, redactTargets, options.vault)
				: redactSpans(input.text, redactTargets);
	}

	return {
		detections,
		feedVersion: options.feed.version,
		matches,
		redactedText,
		verdict: worstVerdict(verdicts),
	};
}
