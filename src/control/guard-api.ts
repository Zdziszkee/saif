import { z } from "zod";

import type { Detection } from "#/control/detectors.ts";
import { filterContent } from "#/control/filter.ts";
import type { FirstLayerPolicy, Verdict } from "#/control/policy.ts";
import { surfaceSchema } from "#/control/policy.ts";
import type { SignatureFeed, SignatureMatch } from "#/control/signatures.ts";
import { createPiiVault } from "#/control/vault.ts";

const MaxContentLength = 65_536;

const demoVault = createPiiVault("saif-demo-vault-2026");

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
	| { error: "invalid_request"; reason: string };

export interface GuardResponse {
	body: GuardResponseBody;
	status: number;
}

function invalidRequest(reason: string): GuardResponse {
	return { body: { error: "invalid_request", reason }, status: 400 };
}

export function handleGuardRequest(
	payload: unknown,
	options: { feed: SignatureFeed; policy?: FirstLayerPolicy },
): GuardResponse {
	const parsed = guardRequestSchema.safeParse(payload);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		return invalidRequest(issue === undefined ? "malformed request" : issue.message);
	}
	const result = filterContent(
		{ surface: parsed.data.surface, text: parsed.data.text },
		{
			...options,
			anonymization: parsed.data.anonymization ?? "placeholder",
			vault: demoVault,
		},
	);
	if (result.verdict === "block" || result.verdict === "escalate") {
		return {
			body: {
				blockedBy: result.matches.length > 0 ? "signature" : "deterministic",
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
