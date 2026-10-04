/**
 * Offline corpus importer (task 5.8).
 *
 * Normalizes third-party payload collections (JailbreakBench artifacts,
 * in-the-wild jailbreak prompts, public payload lists) into feed
 * candidates. Corpora are noisy by nature, so candidates arrive DISABLED
 * with their provenance attached: a curator promotes them by hand-picking
 * patterns into `curated.json`. Candidate ids hash the normalized payload,
 * keeping builder output stable across runs.
 *
 * Accepted files: `.txt` (one payload per line, `#` comments and blanks
 * skipped) and `.json` (an array of strings or of `{text, ref?}` objects).
 * Reads the directory synchronously — this runs in the feed-builder CLI
 * and in tests, never in the request path.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
	escapeRegExp,
	type SignatureEntry,
	type SignatureKind,
	signatureEntrySchema,
} from "../feed.ts";

const MIN_PAYLOAD_CHARS = 8;
const MAX_PAYLOAD_CHARS = 4000;
const NAME_PREVIEW_CHARS = 72;
const ID_HASH_CHARS = 12;
const WHITESPACE_RUN = /\s+/g;

const jsonPayloadSchema = z.union([
	z.string(),
	z.looseObject({ ref: z.string().min(1).optional(), text: z.string() }),
]);

const jsonDocumentSchema = z.array(jsonPayloadSchema);

export interface CorpusPayload {
	ref: string;
	text: string;
}

export interface CorpusImportOptions {
	/** Feed kind for every candidate (corpus files carry no kind of their own). */
	kind: SignatureKind;
	/** Source label recorded on every candidate (e.g. the collection name). */
	source: string;
}

export interface CorpusImport {
	entries: SignatureEntry[];
	errors: string[];
	files: number;
}

function normalizePayload(text: string): string {
	return text.replace(WHITESPACE_RUN, " ").trim();
}

function candidateId(normalized: string): string {
	return `corpus-${createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, ID_HASH_CHARS)}`;
}

function appendPayload(
	payload: CorpusPayload,
	options: CorpusImportOptions,
	importedAt: string,
	acc: { entries: SignatureEntry[]; errors: string[]; seen: Set<string> },
): void {
	const normalized = normalizePayload(payload.text);
	if (normalized.length < MIN_PAYLOAD_CHARS) {
		return;
	}
	if (normalized.length > MAX_PAYLOAD_CHARS) {
		acc.errors.push(`${payload.ref}: payload exceeds ${MAX_PAYLOAD_CHARS} chars, skipped`);
		return;
	}
	const key = normalized.toLowerCase();
	if (acc.seen.has(key)) {
		return;
	}
	acc.seen.add(key);
	const candidate = {
		addedAt: importedAt,
		description: `Corpus candidate from ${options.source} (${payload.ref}); review before enabling`,
		enabled: false,
		id: candidateId(key),
		kind: options.kind,
		name: `Corpus: ${normalized.slice(0, NAME_PREVIEW_CHARS)}`,
		pattern: escapeRegExp(normalized),
		references: [payload.ref],
		severity: "medium",
		source: options.source,
		updatedAt: importedAt,
	};
	const validated = signatureEntrySchema.safeParse(candidate);
	if (!validated.success) {
		acc.errors.push(`${payload.ref}: candidate failed entry validation`);
		return;
	}
	acc.entries.push(validated.data);
}

/** Pure core: normalize payloads into disabled candidates with provenance. */
export function importCorpusPayloads(
	payloads: readonly CorpusPayload[],
	options: CorpusImportOptions,
	importedAt: string,
): CorpusImport {
	const acc: { entries: SignatureEntry[]; errors: string[]; seen: Set<string> } = {
		entries: [],
		errors: [],
		seen: new Set<string>(),
	};
	for (const payload of payloads) {
		appendPayload(payload, options, importedAt, acc);
	}
	return { entries: acc.entries, errors: acc.errors, files: 0 };
}

function payloadsFromText(text: string, ref: string): CorpusPayload[] {
	const payloads: CorpusPayload[] = [];
	for (const [index, line] of text.split("\n").entries()) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith("#")) {
			continue;
		}
		payloads.push({ ref: `${ref}:${index + 1}`, text: trimmed });
	}
	return payloads;
}

function payloadsFromJson(text: string, ref: string, errors: string[]): CorpusPayload[] {
	let document: unknown;
	try {
		document = JSON.parse(text) as unknown;
	} catch {
		errors.push(`${ref}: invalid JSON, skipped`);
		return [];
	}
	const parsed = jsonDocumentSchema.safeParse(document);
	if (!parsed.success) {
		errors.push(`${ref}: expected an array of strings or {text, ref} objects, skipped`);
		return [];
	}
	return parsed.data.map((entry, index) =>
		typeof entry === "string"
			? { ref: `${ref}:${index + 1}`, text: entry }
			: { ref: entry.ref ?? `${ref}:${index + 1}`, text: entry.text },
	);
}

/**
 * Read every `.txt`/`.json` file in a directory into disabled candidates.
 * Unknown extensions are reported and skipped; `importedAt` defaults to the
 * newest source mtime so rebuilds stay deterministic.
 */
export function importCorpusDir(
	dir: string,
	options: CorpusImportOptions,
	importedAt?: string,
): CorpusImport {
	const errors: string[] = [];
	const payloads: CorpusPayload[] = [];
	let files = 0;
	let newest = 0;
	let entries: { name: string }[];
	try {
		entries = readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile())
			.sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return { entries: [], errors: [`corpus directory unreadable: ${dir}`], files: 0 };
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.name.endsWith(".txt")) {
			files += 1;
			newest = Math.max(newest, mtimeOf(path));
			payloads.push(...payloadsFromText(readText(path, errors), path));
		} else if (entry.name.endsWith(".json")) {
			files += 1;
			newest = Math.max(newest, mtimeOf(path));
			payloads.push(...payloadsFromJson(readText(path, errors), path, errors));
		} else {
			errors.push(`${path}: unknown extension, skipped`);
		}
	}
	const stamp = importedAt ?? new Date(newest).toISOString();
	const imported = importCorpusPayloads(payloads, options, stamp);
	return { entries: imported.entries, errors: [...errors, ...imported.errors], files };
}

function mtimeOf(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

function readText(path: string, errors: string[]): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		errors.push(`${path}: unreadable, skipped`);
		return "";
	}
}
