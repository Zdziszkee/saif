import { type Detection, detectSensitive } from "#/control/detectors.ts";
import {
	defaultFirstLayerPolicy,
	type FirstLayerPolicy,
	resolveDeterministicAction,
	resolveSignatureAction,
	surfaceDirection,
	type Verdict,
	worstVerdict,
} from "#/control/policy.ts";
import { applyRedactions, detectionOps, type RedactionOp } from "#/control/redact.ts";
import { matchSignatures, type SignatureFeed, type SignatureMatch } from "#/control/signatures.ts";
import { detectionTokenOps, type PiiVault } from "#/control/vault.ts";

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
	deterministicVerdict: Verdict;
	feedVersion: string;
	matches: SignatureMatch[];
	redactedText: string;
	signatureVerdict: Verdict;
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

	const signatureVerdicts: Verdict[] = [];
	const signatureOps: RedactionOp[] = [];
	for (const match of matches) {
		const action = resolveSignatureAction(policy, match.severity, match.action);
		signatureVerdicts.push(action);
		if (action === "redact") {
			signatureOps.push({
				end: match.end,
				start: match.start,
				text: `[SIGNATURE:${match.signatureId}]`,
			});
		}
	}

	const deterministicVerdicts: Verdict[] = [];
	const redactTargets: Detection[] = [];
	for (const detection of detections) {
		const action = resolveDeterministicAction(policy, detection, direction);
		deterministicVerdicts.push(action);
		if (action === "redact") {
			redactTargets.push(detection);
		}
	}

	let redactedText = input.text;
	const vault = options.anonymization === "tokenize" ? options.vault : undefined;
	if (redactTargets.length > 0 || signatureOps.length > 0) {
		const detectionOpsList =
			vault === undefined ? detectionOps(redactTargets) : detectionTokenOps(redactTargets, vault);
		redactedText = applyRedactions(input.text, [...detectionOpsList, ...signatureOps]);
	}

	const signatureVerdict = worstVerdict(signatureVerdicts);
	const deterministicVerdict = worstVerdict(deterministicVerdicts);
	const verdict = worstVerdict([signatureVerdict, deterministicVerdict]);

	return {
		detections,
		deterministicVerdict,
		feedVersion: options.feed.version,
		matches,
		redactedText,
		signatureVerdict,
		verdict,
	};
}
