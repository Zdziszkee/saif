/**
 * MITRE ATLAS STIX 2.1 snapshot adapter (task 5.8).
 *
 * Parses a vendored ATLAS bundle into pick records: attack-pattern objects
 * carrying `x_signature_ids` claims plus their external references. Revoked
 * patterns are skipped silently (withdrawn intel must not linger); anything
 * else malformed is reported, never thrown. Pure JSON in, no network —
 * fetching snapshots is the currency poller's job.
 */

import { z } from "zod";

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
