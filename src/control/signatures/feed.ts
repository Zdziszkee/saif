/**
 * Signature feed: known AI-exploit patterns matched deterministically.
 *
 * Entries are validated individually — one bad row is reported and skipped
 * without disabling the rest of the feed. The feed carries a SHA-256 version
 * stamp so every match can cite the exact feed in force, and a file-backed
 * store keeps the last good feed across failed reloads (fail-closed input,
 * never a silently empty feed).
 */

import type { FSWatcher } from "node:fs";
import { readFileSync, watch } from "node:fs";
import { z } from "zod";
import { sha256Hex } from "#/control/hash.ts";

export const signatureKindSchema = z.enum([
	"injection",
	"jailbreak",
	"malicious-code",
	"supply-chain",
	"tool-abuse",
	"unsafe-deserialization",
]);
export type SignatureKind = z.infer<typeof signatureKindSchema>;

export const signatureSeveritySchema = z.enum(["critical", "high", "low", "medium"]);
export type SignatureSeverity = z.infer<typeof signatureSeveritySchema>;

export const signatureEntrySchema = z.strictObject({
	addedAt: z.string().datetime(),
	description: z.string().min(1),
	enabled: z.boolean().default(true),
	id: z.string().min(1),
	kind: signatureKindSchema,
	name: z.string().min(1),
	pattern: z.string().min(1),
	references: z.array(z.string().min(1)).default([]),
	severity: signatureSeveritySchema,
	source: z.string().min(1),
	updatedAt: z.string().datetime(),
});
export type SignatureEntry = z.infer<typeof signatureEntrySchema>;

export interface CompiledSignature extends SignatureEntry {
	regex: RegExp;
}

export interface SignatureFeed {
	entries: CompiledSignature[];
	version: string;
}

export interface FeedLoadError {
	entryId: string | null;
	message: string;
}

export interface FeedLoadResult {
	entries: CompiledSignature[];
	errors: FeedLoadError[];
	version: string;
}

function feedVersion(canonical: string): string {
	return sha256Hex(canonical);
}

function compileEntry(entry: SignatureEntry): CompiledSignature | string {
	try {
		return { ...entry, regex: new RegExp(entry.pattern, "gi") };
	} catch (error) {
		return error instanceof Error ? error.message : "pattern does not compile";
	}
}

/**
 * Parse feed JSON into compiled entries. Accepts an array of entries;
 * anything else is a document-level failure with zero entries.
 */
export function loadSignatureFeed(document: unknown): FeedLoadResult {
	const parsed = z.array(z.unknown()).safeParse(document);
	if (!parsed.success) {
		return {
			entries: [],
			errors: [{ entryId: null, message: "feed must be an array of signature entries" }],
			version: feedVersion("[]"),
		};
	}
	const entries: CompiledSignature[] = [];
	const errors: FeedLoadError[] = [];
	const seenIds = new Set<string>();
	for (const raw of parsed.data) {
		const validated = signatureEntrySchema.safeParse(raw);
		if (!validated.success) {
			errors.push({ entryId: null, message: "entry failed schema validation" });
			continue;
		}
		if (seenIds.has(validated.data.id)) {
			errors.push({ entryId: validated.data.id, message: "duplicate signature id" });
			continue;
		}
		seenIds.add(validated.data.id);
		const compiled = compileEntry(validated.data);
		if (typeof compiled === "string") {
			errors.push({ entryId: validated.data.id, message: `invalid regex: ${compiled}` });
			continue;
		}
		entries.push(compiled);
	}
	return {
		entries,
		errors,
		version: feedVersion(JSON.stringify(parsed.data)),
	};
}

export interface SignatureFeedSnapshot {
	errors: FeedLoadError[];
	feed: SignatureFeed;
	ok: boolean;
}

export interface SignatureFeedStore {
	close(): void;
	reload(): SignatureFeedSnapshot;
	snapshot(): SignatureFeedSnapshot;
}

function failedSnapshot(errors: FeedLoadError[], fallback: SignatureFeed): SignatureFeedSnapshot {
	return { errors, feed: fallback, ok: false };
}

function readDocument(path: string): { error?: string; parsed?: unknown } {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		return { error: error instanceof Error ? error.message : "unreadable feed" };
	}
	try {
		return { parsed: JSON.parse(text) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : "invalid JSON" };
	}
}

/**
 * File-backed feed with hot reload: edits take effect for subsequent
 * inspections without a restart, and a failed reload keeps serving the last
 * good feed flagged unhealthy instead of going unprotected.
 */
export function createSignatureFeedStore(path: string): SignatureFeedStore {
	const empty: SignatureFeed = { entries: [], version: "unavailable" };
	let lastGood: SignatureFeed | null = null;
	let state: SignatureFeedSnapshot = { errors: [], feed: empty, ok: false };
	let watcher: FSWatcher | null = null;

	function read(): SignatureFeedSnapshot {
		const document = readDocument(path);
		if (document.error !== undefined) {
			return failedSnapshot([{ entryId: null, message: document.error }], lastGood ?? empty);
		}
		const loaded = loadSignatureFeed(document.parsed);
		if (loaded.entries.length === 0) {
			return failedSnapshot(
				loaded.errors.length > 0
					? loaded.errors
					: [{ entryId: null, message: "feed contains no usable signatures" }],
				lastGood ?? empty,
			);
		}
		lastGood = { entries: loaded.entries, version: loaded.version };
		return { errors: loaded.errors, feed: lastGood, ok: true };
	}

	state = read();
	try {
		// A missing file must degrade to the failed snapshot above, not throw
		// at construction and take down every importer of the store.
		watcher = watch(path, { persistent: false }, () => {
			state = read();
		});
	} catch {
		watcher = null;
	}

	return {
		close() {
			watcher?.close();
			watcher = null;
		},
		reload() {
			state = read();
			return state;
		},
		snapshot() {
			return state;
		},
	};
}
