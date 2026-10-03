export interface DetectionView {
	confidence: number;
	context?: string[];
	detectorId: string;
	kind: string;
	type: string;
	validated: boolean;
	value: string;
}

export interface MatchView {
	kind: string;
	severity: string;
	signatureId: string;
	source: string;
	value: string;
}

export interface GuardResultView {
	blockedBy?: string;
	detections: DetectionView[];
	error?: string;
	feedVersion?: string;
	matches: MatchView[];
	reason?: string;
	redactedText?: string;
	verdict?: string;
}

interface RawGuardBody {
	blockedBy?: unknown;
	detections?: unknown;
	error?: unknown;
	feedVersion?: unknown;
	matches?: unknown;
	reason?: unknown;
	redactedText?: unknown;
	verdict?: unknown;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function normalizeGuardResult(value: unknown): GuardResultView {
	const fallback: GuardResultView = { detections: [], error: "invalid_response", matches: [] };
	if (typeof value !== "object" || value === null) {
		return fallback;
	}
	const record = value as RawGuardBody;
	const error = asString(record.error);
	if (error !== undefined) {
		const result: GuardResultView = { detections: [], error, matches: [] };
		const reason = asString(record.reason);
		if (reason !== undefined) {
			result.reason = reason;
		}
		return result;
	}
	if (!(Array.isArray(record.detections) && Array.isArray(record.matches))) {
		return fallback;
	}
	const result: GuardResultView = {
		detections: record.detections as DetectionView[],
		matches: record.matches as MatchView[],
	};
	const blockedBy = asString(record.blockedBy);
	if (blockedBy !== undefined) {
		result.blockedBy = blockedBy;
	}
	const feedVersion = asString(record.feedVersion);
	if (feedVersion !== undefined) {
		result.feedVersion = feedVersion;
	}
	const redactedText = asString(record.redactedText);
	if (redactedText !== undefined) {
		result.redactedText = redactedText;
	}
	const verdict = asString(record.verdict);
	if (verdict !== undefined) {
		result.verdict = verdict;
	}
	return result;
}
