import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import type { SignatureEntry } from "../src/control/signatures/feed.ts";
import { loadSignatureFeed, signatureEntrySchema } from "../src/control/signatures/feed.ts";

const ATLAS_PATH = "data/feeds/atlas-snapshot.json";
const CURATED_PATH = "data/feeds/curated.json";
const OUT_PATH = "signatures.json";
const OWASP_PATH = "data/feeds/owasp-snapshot.json";

const attackPatternSchema = z.looseObject({
	external_references: z.array(z.looseObject({ url: z.string().min(1).optional() })).default([]),
	name: z.string().min(1),
	revoked: z.boolean().optional(),
	type: z.literal("attack-pattern"),
	x_signature_ids: z.array(z.string().min(1)).default([]),
});

const atlasBundleSchema = z.looseObject({
	objects: z.array(z.unknown()),
	type: z.literal("bundle"),
});

const owaspCategorySchema = z.looseObject({
	id: z.string().min(1),
	signature_ids: z.array(z.string().min(1)).default([]),
	title: z.string().min(1),
});

const owaspSnapshotSchema = z.looseObject({
	categories: z.array(z.unknown()),
	source: z.string().min(1),
	version: z.string().min(1),
});

const stixKindSchema = z.looseObject({ type: z.string() });

export interface AtlasPick {
	claims: string[];
	name: string;
	references: string[];
}

export interface AtlasParse {
	errors: string[];
	picks: AtlasPick[];
}

export interface OwaspParse {
	categories: string[];
	claims: string[];
	errors: string[];
}

export interface FeedBuild {
	document: SignatureEntry[];
	errors: string[];
	warnings: string[];
}

function appendAtlasPick(raw: unknown, picks: AtlasPick[], errors: string[]): void {
	if (typeof raw !== "object" || raw === null) {
		return;
	}
	const kind = stixKindSchema.safeParse(raw);
	if (!kind.success || kind.data.type !== "attack-pattern") {
		return;
	}
	const entry = attackPatternSchema.safeParse(raw);
	if (!entry.success) {
		errors.push("atlas attack-pattern failed validation");
		return;
	}
	if (entry.data.revoked === true) {
		return;
	}
	const references: string[] = [];
	for (const ref of entry.data.external_references) {
		if (ref.url !== undefined) {
			references.push(ref.url);
		}
	}
	picks.push({
		claims: [...entry.data.x_signature_ids],
		name: entry.data.name,
		references,
	});
}

export function parseAtlasSnapshot(document: unknown): AtlasParse {
	const errors: string[] = [];
	const picks: AtlasPick[] = [];
	const parsed = atlasBundleSchema.safeParse(document);
	if (!parsed.success) {
		return { errors: ["atlas snapshot is not a STIX 2.1 bundle"], picks };
	}
	for (const raw of parsed.data.objects) {
		appendAtlasPick(raw, picks, errors);
	}
	if (picks.length === 0 && errors.length === 0) {
		errors.push("atlas snapshot contains no usable attack-patterns");
	}
	return { errors, picks };
}

export function parseOwaspSnapshot(document: unknown): OwaspParse {
	const errors: string[] = [];
	const categories: string[] = [];
	const claims: string[] = [];
	const parsed = owaspSnapshotSchema.safeParse(document);
	if (!parsed.success) {
		return { categories, claims, errors: ["owasp snapshot has no categories"] };
	}
	for (const raw of parsed.data.categories) {
		const entry = owaspCategorySchema.safeParse(raw);
		if (!entry.success) {
			errors.push("owasp category failed validation");
			continue;
		}
		categories.push(entry.data.id);
		for (const id of entry.data.signature_ids) {
			claims.push(id);
		}
	}
	if (categories.length === 0 && errors.length === 0) {
		errors.push("owasp snapshot contains no usable categories");
	}
	return { categories, claims, errors };
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

export function buildSignatureFeed(curated: unknown, atlas: unknown, owasp: unknown): FeedBuild {
	const atlasParse = atlas === undefined ? null : parseAtlasSnapshot(atlas);
	const owaspParse = owasp === undefined ? null : parseOwaspSnapshot(owasp);
	const errors: string[] = [];
	if (atlasParse !== null) {
		errors.push(...prefixErrors("atlas", atlasParse.errors));
	}
	if (owaspParse !== null) {
		errors.push(...prefixErrors("owasp", owaspParse.errors));
	}
	const validated = validateCuratedRows(curated);
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
	const built = buildSignatureFeed(curated.document, atlas.document, owasp.document);
	for (const warning of built.warnings) {
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

if (process.argv[1]?.endsWith("build-signature-feed.ts") ?? false) {
	main();
}
