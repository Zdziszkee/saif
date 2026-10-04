/**
 * OSV malicious-package adapter (task 5.8).
 *
 * Parses OSV API response documents (`v1/query` responses or bare vuln
 * arrays) into supply-chain signature candidates: install-command patterns
 * that match references to known-malicious packages (`MAL-*` ids only —
 * CVEs in legitimate packages are not signatures). Withdrawn entries are
 * skipped silently (retracted intel must not linger); anything else
 * unusable is reported. Pure JSON in, no network — live querying belongs
 * to a scheduler built on the currency poller, not to this parser.
 */

import { z } from "zod";
import { escapeRegExp, type SignatureEntry, signatureEntrySchema } from "../feed.ts";

const osvReferenceSchema = z.looseObject({
	type: z.string().min(1).optional(),
	url: z.string().min(1).optional(),
});

const osvPackageSchema = z.looseObject({
	ecosystem: z.string().min(1),
	name: z.string().min(1),
});

const osvVulnSchema = z.looseObject({
	affected: z.array(z.looseObject({ package: osvPackageSchema.optional() })).default([]),
	id: z.string().min(1),
	modified: z.string().min(1),
	package: osvPackageSchema.optional(),
	published: z.string().min(1),
	references: z.array(osvReferenceSchema).default([]),
	summary: z.string().min(1).optional(),
	withdrawn: z.unknown().optional(),
});

const osvResponseSchema = z.looseObject({ vulns: z.array(z.unknown()).default([]) });

const MAL_ID = /^MAL-/;
const SUMMARY_PREVIEW_CHARS = 140;

export interface OsvParse {
	entries: SignatureEntry[];
	errors: string[];
	skipped: { nonMal: number; unsupported: number; withdrawn: number };
}

function emptySkipped(): OsvParse["skipped"] {
	return { nonMal: 0, unsupported: 0, withdrawn: 0 };
}

/**
 * Installer-command pattern for one malicious package. Scoped to install
 * verbs so a bare package name in prose can never match — the pattern fires
 * only when something actually installs it.
 */
function installerPattern(ecosystem: string, packageName: string): string | null {
	const name = escapeRegExp(packageName);
	switch (ecosystem) {
		case "npm":
			return `(?:npm\\s+(?:install|i)|yarn\\s+add|pnpm\\s+add)\\s+[^\\r\\n]*?${name}\\b`;
		case "PyPI":
			return `pip\\s+install\\s+[^\\r\\n]*?${name}\\b`;
		case "Go":
			return `go\\s+get\\s+[^\\r\\n]*?${name}\\b`;
		case "RubyGems":
			return `(?:gem\\s+install|bundle\\s+add)\\s+[^\\r\\n]*?${name}\\b`;
		case "crates.io":
			return `cargo\\s+(?:add|install)\\s+[^\\r\\n]*?${name}\\b`;
		default:
			return null;
	}
}

function entryId(vulnId: string): string {
	return `osv-${vulnId
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")}`;
}

function appendOsvVuln(
	raw: unknown,
	parse: { entries: SignatureEntry[]; errors: string[]; skipped: OsvParse["skipped"] },
): void {
	const vuln = osvVulnSchema.safeParse(raw);
	if (!vuln.success) {
		parse.errors.push("osv entry failed validation");
		return;
	}
	const data = vuln.data;
	if (data.withdrawn) {
		parse.skipped.withdrawn += 1;
		return;
	}
	if (!MAL_ID.test(data.id)) {
		parse.skipped.nonMal += 1;
		return;
	}
	const pkg = data.affected[0]?.package ?? data.package;
	if (pkg === undefined) {
		parse.errors.push(`osv ${data.id}: no affected package`);
		return;
	}
	const pattern = installerPattern(pkg.ecosystem, pkg.name);
	if (pattern === null) {
		parse.skipped.unsupported += 1;
		return;
	}
	const summary =
		data.summary === undefined ? "" : ` — ${data.summary.slice(0, SUMMARY_PREVIEW_CHARS)}`;
	const candidate = {
		addedAt: data.published,
		description: `OSV ${data.id}: malicious ${pkg.ecosystem} package ${pkg.name}${summary}`,
		enabled: true,
		id: entryId(data.id),
		kind: "supply-chain",
		name: `Malicious package ${pkg.name} (${pkg.ecosystem})`,
		pattern,
		references: [
			`https://osv.dev/vulnerability/${data.id}`,
			...data.references.flatMap((ref) => (ref.url === undefined ? [] : [ref.url])),
		],
		severity: "critical",
		source: "osv-mal",
		updatedAt: data.modified,
	};
	const validated = signatureEntrySchema.safeParse(candidate);
	if (!validated.success) {
		parse.errors.push(`osv ${data.id}: candidate failed entry validation`);
		return;
	}
	try {
		new RegExp(validated.data.pattern);
	} catch {
		parse.errors.push(`osv ${data.id}: candidate pattern does not compile`);
		return;
	}
	parse.entries.push(validated.data);
}

/** Parse an OSV query-response object or a bare vuln array into candidates. */
export function parseOsvResponse(document: unknown): OsvParse {
	const parse: { entries: SignatureEntry[]; errors: string[]; skipped: OsvParse["skipped"] } = {
		entries: [],
		errors: [],
		skipped: emptySkipped(),
	};
	if (Array.isArray(document)) {
		for (const raw of document) {
			appendOsvVuln(raw, parse);
		}
		return parse;
	}
	if (typeof document !== "object" || document === null || !("vulns" in document)) {
		parse.errors.push("osv document is not a query response");
		return parse;
	}
	const parsed = osvResponseSchema.safeParse(document);
	if (!parsed.success) {
		parse.errors.push("osv document is not a query response");
		return parse;
	}
	for (const raw of parsed.data.vulns) {
		appendOsvVuln(raw, parse);
	}
	return parse;
}
