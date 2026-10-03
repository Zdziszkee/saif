import { z } from "zod";

import type { Detection } from "#/control/detectors.ts";
import { type FilterOptions, filterContent } from "#/control/filter.ts";
import type { FirstLayerPolicy, Verdict } from "#/control/policy.ts";
import { surfaceSchema } from "#/control/policy.ts";
import type { SignatureFeed, SignatureMatch } from "#/control/signatures.ts";
import type { PiiVault } from "#/control/vault.ts";

const MaxContentLength = 65_536;

export const guardRequestSchema = z.object({
	anonymization: z.enum(["placeholder", "tokenize"]).optional(),
	surface: surfaceSchema,
	text: z.string().min(1).max(MaxContentLength),
});
export type GuardRequest = z.infer<typeof guardRequestSchema>;

export type GuardResponseBody =
	| {
			blockedBy: "deterministic" | "signature";
			detections: Detection[];
			feedVersion: string;
			matches: SignatureMatch[];
			verdict: Verdict;
	  }
	| {
			detections: Detection[];
			feedVersion: string;
			matches: SignatureMatch[];
			redactedText: string;
			verdict: Verdict;
	  }
	| { error: "feed_unavailable"; reason: string }
	| { error: "invalid_request"; reason: string };

export interface GuardResponse {
	body: GuardResponseBody;
	status: number;
}

export interface GuardOptions {
	feed: SignatureFeed;
	feedOk?: boolean;
	policy?: FirstLayerPolicy;
	vault?: PiiVault | null;
}

function invalidRequest(reason: string): GuardResponse {
	return { body: { error: "invalid_request", reason }, status: 400 };
}

export function handleGuardRequest(payload: unknown, options: GuardOptions): GuardResponse {
	const parsed = guardRequestSchema.safeParse(payload);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		return invalidRequest(issue === undefined ? "malformed request" : issue.message);
	}
	if (options.feedOk === false) {
		return {
			body: { error: "feed_unavailable", reason: "signature feed is unavailable" },
			status: 503,
		};
	}
	const vault = options.vault ?? null;
	if (parsed.data.anonymization === "tokenize" && vault === null) {
		return invalidRequest("reversible tokenization requires VAULT_SECRET");
	}
	const filterOptions: FilterOptions = {
		anonymization: parsed.data.anonymization ?? "placeholder",
		feed: options.feed,
	};
	if (options.policy !== undefined) {
		filterOptions.policy = options.policy;
	}
	if (vault !== null) {
		filterOptions.vault = vault;
	}
	const result = filterContent(
		{ surface: parsed.data.surface, text: parsed.data.text },
		filterOptions,
	);
	if (result.verdict === "block" || result.verdict === "escalate") {
		return {
			body: {
				blockedBy: result.signatureVerdict === result.verdict ? "signature" : "deterministic",
				detections: result.detections,
				feedVersion: result.feedVersion,
				matches: result.matches,
				verdict: result.verdict,
			},
			status: 403,
		};
	}
	return {
		body: {
			detections: result.detections,
			feedVersion: result.feedVersion,
			matches: result.matches,
			redactedText: result.redactedText,
			verdict: result.verdict,
		},
		status: 200,
	};
}
