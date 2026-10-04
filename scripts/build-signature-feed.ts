import { readFileSync, writeFileSync } from "node:fs";
import type { SignatureEntry } from "../src/control/signatures/feed.ts";
import {
	loadSignatureFeed,
	signatureEntrySchema,
	signatureKindSchema,
} from "../src/control/signatures/feed.ts";
import { type AtlasParse, parseAtlasSnapshot } from "../src/control/signatures/sources/atlas.ts";
import { importCorpusDir } from "../src/control/signatures/sources/corpus.ts";
import { parseOsvResponse } from "../src/control/signatures/sources/osv.ts";
import { type OwaspParse, parseOwaspSnapshot } from "../src/control/signatures/sources/owasp.ts";

const ATLAS_PATH = "data/feeds/atlas-snapshot.json";
const CURATED_PATH = "data/feeds/curated.json";
const OUT_PATH = "signatures.json";
const OWASP_PATH = "data/feeds/owasp-snapshot.json";

export interface FeedBuild {
	document: SignatureEntry[];
	errors: string[];
	warnings: string[];
}

function validateCuratedRows(curated: unknown): { entries: SignatureEntry[]; errors: string[] } {
	const entries: SignatureEntry[] = [];
	const errors: string[] = [];
	if (!Array.isArray(curated)) {
		return { entries, errors: ["curated pick list must be an array"] };
	}
	const seen = new Set<string>();
	for (const [index, raw] of curated.entries()) {
		const validated = signatureEntrySchema.safeParse(raw);
		if (!validated.success) {
			errors.push(`curated[${index}]: entry failed schema validation`);
			continue;
		}
		if (seen.has(validated.data.id)) {
			errors.push(`curated[${index}]: duplicate signature id ${validated.data.id}`);
			continue;
		}
		try {
			new RegExp(validated.data.pattern);
		} catch {
			errors.push(`curated[${index}]: invalid regex for ${validated.data.id}`);
			continue;
		}
		seen.add(validated.data.id);
		entries.push(validated.data);
	}
	return { entries, errors };
}

function collectClaimedIds(
	atlasParse: AtlasParse | null,
	owaspParse: OwaspParse | null,
): Set<string> {
	const claimed = new Set<string>();
	if (atlasParse !== null) {
		for (const pick of atlasParse.picks) {
			for (const id of pick.claims) {
				claimed.add(id);
			}
		}
	}
	if (owaspParse !== null) {
		for (const id of owaspParse.claims) {
			claimed.add(id);
		}
	}
	return claimed;
}

function coverageWarnings(entries: SignatureEntry[], claimed: Set<string>): string[] {
	const warnings: string[] = [];
	if (claimed.size === 0) {
		return warnings;
	}
	for (const entry of entries) {
		if (!claimed.has(entry.id)) {
			warnings.push(`unclaimed curated id ${entry.id} (no snapshot object picks it)`);
		}
	}
	const known = new Set(entries.map((entry) => entry.id));
	for (const id of claimed) {
		if (!known.has(id)) {
			warnings.push(`unknown snapshot claim ${id} (snapshot ahead of pick list)`);
		}
	}
	return warnings;
}

function prefixErrors(prefix: string, errors: string[]): string[] {
	return errors.map((error) => `${prefix}: ${error}`);
}

export interface FeedExtraSources {
	corpus?: { entries: SignatureEntry[]; errors: string[] };
	osv?: { entries: SignatureEntry[]; errors: string[] };
}

export function buildSignatureFeed(
	curated: unknown,
	atlas: unknown,
	owasp: unknown,
	extra: FeedExtraSources = {},
): FeedBuild {
	const atlasParse = atlas === undefined ? null : parseAtlasSnapshot(atlas);
	const owaspParse = owasp === undefined ? null : parseOwaspSnapshot(owasp);
	const errors: string[] = [];
	if (atlasParse !== null) {
		errors.push(...prefixErrors("atlas", atlasParse.errors));
	}
	if (owaspParse !== null) {
		errors.push(...prefixErrors("owasp", owaspParse.errors));
	}
	const extraRows: unknown[] = [];
	if (extra.osv !== undefined) {
		errors.push(...prefixErrors("osv", extra.osv.errors));
		extraRows.push(...extra.osv.entries);
	}
	if (extra.corpus !== undefined) {
		errors.push(...prefixErrors("corpus", extra.corpus.errors));
		extraRows.push(...extra.corpus.entries);
	}
	const validated = validateCuratedRows(
		Array.isArray(curated) ? [...curated, ...extraRows] : curated,
	);
	errors.push(...validated.errors);
	const warnings = coverageWarnings(validated.entries, collectClaimedIds(atlasParse, owaspParse));
	if (validated.entries.length === 0) {
		errors.push("feed contains no usable signatures");
		return { document: [], errors, warnings };
	}
	const loaded = loadSignatureFeed(validated.entries);
	if (loaded.entries.length !== validated.entries.length) {
		for (const error of loaded.errors) {
			errors.push(`feed: ${error.entryId ?? "document"} ${error.message}`);
		}
		return { document: [], errors, warnings };
	}
	const document = [...validated.entries].sort((a, b) => a.id.localeCompare(b.id));
	return { document, errors, warnings };
}

function readJson(path: string): { document?: unknown; error?: string } {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return { error: `unreadable file ${path}` };
	}
	try {
		return { document: JSON.parse(text) as unknown };
	} catch {
		return { error: `invalid JSON in ${path}` };
	}
}

export function main(): void {
	const checkOnly = process.argv.includes("--check");
	const curated = readJson(CURATED_PATH);
	if (curated.error !== undefined || curated.document === undefined) {
		console.error(curated.error ?? "unreadable curated pick list");
		process.exit(1);
	}
	const atlas = readJson(ATLAS_PATH);
	const owasp = readJson(OWASP_PATH);
	const extra = readExtraSources();
	const built = buildSignatureFeed(curated.document, atlas.document, owasp.document, extra.sources);
	for (const warning of [...extra.warnings, ...built.warnings]) {
		console.warn(`warn: ${warning}`);
	}
	for (const error of built.errors) {
		console.error(`error: ${error}`);
	}
	if (built.errors.length > 0 || built.document.length === 0) {
		process.exit(1);
	}
	if (checkOnly) {
		console.log(`signatures: ${built.document.length} entries validate`);
		return;
	}
	writeFileSync(OUT_PATH, `${JSON.stringify(built.document, null, "\t")}\n`);
	console.log(`signatures: wrote ${built.document.length} entries to ${OUT_PATH}`);
}

function flagValue(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	if (index === -1) {
		return;
	}
	const value = process.argv[index + 1];
	return value === undefined || value.length === 0 ? undefined : value;
}

function readExtraSources(): { sources: FeedExtraSources; warnings: string[] } {
	const sources: FeedExtraSources = {};
	const warnings: string[] = [];
	const osvPath = flagValue("--osv");
	if (osvPath !== undefined) {
		const response = readJson(osvPath);
		if (response.error !== undefined || response.document === undefined) {
			console.error(response.error ?? `unreadable OSV response ${osvPath}`);
			process.exit(1);
		}
		const parsed = parseOsvResponse(response.document);
		const skipped = parsed.skipped;
		if (skipped.nonMal + skipped.unsupported + skipped.withdrawn > 0) {
			warnings.push(
				`osv: skipped ${skipped.withdrawn} withdrawn, ${skipped.nonMal} non-MAL, ${skipped.unsupported} unsupported-ecosystem entries`,
			);
		}
		sources.osv = { entries: parsed.entries, errors: parsed.errors };
	}
	const corpusDir = flagValue("--corpus");
	if (corpusDir !== undefined) {
		const kind = flagValue("--corpus-kind") ?? "injection";
		const parsedKind = signatureKindSchema.safeParse(kind);
		if (!parsedKind.success) {
			console.error(`invalid --corpus-kind ${kind}`);
			process.exit(1);
		}
		const imported = importCorpusDir(corpusDir, {
			kind: parsedKind.data,
			source: flagValue("--corpus-source") ?? "local-corpus",
		});
		warnings.push(
			`corpus: ${imported.entries.length} candidates from ${imported.files} files (disabled, review before enabling)`,
		);
		sources.corpus = { entries: imported.entries, errors: imported.errors };
	}
	return { sources, warnings };
}

if (process.argv[1]?.endsWith("build-signature-feed.ts") ?? false) {
	main();
}
