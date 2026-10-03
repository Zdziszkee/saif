import { createHash } from "node:crypto";
import { z } from "zod";

import type { Verdict } from "#/control/policy.ts";
import { verdictSchema } from "#/control/policy.ts";

export const signatureKindSchema = z.enum([
	"data_exfiltration",
	"jailbreak",
	"prompt_injection",
	"supply_chain",
	"tool_abuse",
	"unsafe_deserialization",
]);
export type SignatureKind = z.infer<typeof signatureKindSchema>;

export const signatureSeveritySchema = z.enum(["critical", "high", "low", "medium"]);
export type SignatureSeverity = z.infer<typeof signatureSeveritySchema>;

export const signatureSchema = z.object({
	action: verdictSchema.optional(),
	addedAt: z.string().datetime(),
	description: z.string().min(1),
	id: z.string().min(1),
	kind: signatureKindSchema,
	name: z.string().min(1),
	pattern: z.string().min(1),
	severity: signatureSeveritySchema,
	source: z.string().min(1),
	updatedAt: z.string().datetime(),
});
export type Signature = z.infer<typeof signatureSchema>;

export interface ActiveSignature extends Signature {
	regex: RegExp;
}

export interface SignatureFeed {
	signatures: ActiveSignature[];
	version: string;
}

export interface FeedError {
	entryId: string | null;
	message: string;
}

export interface SignatureMatch {
	action: Verdict | undefined;
	end: number;
	kind: SignatureKind;
	severity: SignatureSeverity;
	signatureId: string;
	source: string;
	start: number;
	value: string;
}

export interface ParsedFeed {
	documentOk: boolean;
	errors: FeedError[];
	feed: SignatureFeed;
}

export function hashContent(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function compile(signature: Signature): ActiveSignature | FeedError {
	try {
		return { ...signature, regex: new RegExp(signature.pattern, "gi") };
	} catch (error) {
		const message = error instanceof Error ? error.message : "invalid pattern";
		return { entryId: signature.id, message: `invalid regex: ${message}` };
	}
}

export function parseSignatureFeed(text: string): ParsedFeed {
	const errors: FeedError[] = [];
	const signatures: ActiveSignature[] = [];
	const seenIds = new Set<string>();
	const version = hashContent(text);

	let document: unknown;
	try {
		document = JSON.parse(text);
	} catch (error) {
		const message = error instanceof Error ? error.message : "invalid JSON";
		return {
			documentOk: false,
			errors: [{ entryId: null, message }],
			feed: { signatures: [], version },
		};
	}

	const entries = z.array(z.unknown()).safeParse(document);
	if (!entries.success) {
		return {
			documentOk: false,
			errors: [{ entryId: null, message: "feed must be an array of signature entries" }],
			feed: { signatures: [], version },
		};
	}

	for (const rawEntry of entries.data) {
		const parsed = signatureSchema.safeParse(rawEntry);
		if (!parsed.success) {
			errors.push({ entryId: null, message: "entry failed schema validation" });
			continue;
		}
		const entry = parsed.data;
		if (seenIds.has(entry.id)) {
			errors.push({ entryId: entry.id, message: "duplicate signature id" });
			continue;
		}
		const compiled = compile(entry);
		if ("message" in compiled) {
			errors.push(compiled);
			continue;
		}
		seenIds.add(entry.id);
		signatures.push(compiled);
	}

	return { documentOk: true, errors, feed: { signatures, version } };
}

export function matchSignatures(
	text: string,
	signatures: readonly ActiveSignature[],
): SignatureMatch[] {
	const matches: SignatureMatch[] = [];
	for (const signature of signatures) {
		const regex = new RegExp(signature.regex.source, signature.regex.flags);
		for (const match of text.matchAll(regex)) {
			const value = match[0];
			const start = match.index;
			if (value === undefined || start === undefined) {
				continue;
			}
			matches.push({
				action: signature.action,
				end: start + value.length,
				kind: signature.kind,
				severity: signature.severity,
				signatureId: signature.id,
				source: signature.source,
				start,
				value,
			});
		}
	}
	return matches.sort((a, b) => a.start - b.start);
}
