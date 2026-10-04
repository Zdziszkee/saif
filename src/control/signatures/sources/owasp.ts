/**
 * OWASP LLM Top 10 snapshot adapter (task 5.8).
 *
 * Parses a vendored OWASP snapshot into category designations plus the
 * signature ids each category claims. Categories that fail validation are
 * reported and skipped; an empty-but-valid snapshot is an error, never a
 * silent pass. Pure JSON in, no network.
 */

import { z } from "zod";

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

export interface OwaspParse {
	categories: string[];
	claims: string[];
	errors: string[];
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
