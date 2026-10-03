/**
 * Verdict enforcement helper: applies typed-placeholder redaction over the
 * detected spans, preserving all surrounding content. Enforcement lives in the
 * gateway; the controls that detect spans plug in behind the pipeline seam.
 */

import type { RedactionSpan } from "./types.ts";

/**
 * Replace every detected span with its typed placeholder. Spans are applied
 * back to front; overlapping or out-of-range spans are skipped so a bad span
 * can never corrupt the surrounding content.
 */
export function applyRedactions(content: string, spans: readonly RedactionSpan[]): string {
	const ordered = [...spans]
		.filter((span) => span.start >= 0 && span.end <= content.length && span.start < span.end)
		.sort((a, b) => b.start - a.start || b.end - a.end);

	let result = content;
	let lastStart = Number.POSITIVE_INFINITY;
	for (const span of ordered) {
		if (span.end > lastStart) {
			continue;
		}
		result = result.slice(0, span.start) + span.placeholder + result.slice(span.end);
		lastStart = span.start;
	}
	return result;
}

/**
 * Redact serialized JSON content (tool arguments, tool results) and re-parse
 * it. When redaction breaks the JSON structure, every string leaf is replaced
 * with a generic placeholder so nothing sensitive can survive the fallback.
 */
export function redactJson(content: string, spans: readonly RedactionSpan[]): string {
	const redacted = applyRedactions(content, spans);
	try {
		JSON.parse(redacted);
		return redacted;
	} catch {
		return JSON.stringify(redactStringLeaves(JSON.parse(content)));
	}
}

function redactStringLeaves(value: unknown): unknown {
	if (typeof value === "string") {
		return "[REDACTED]";
	}
	if (Array.isArray(value)) {
		return value.map(redactStringLeaves);
	}
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value).map(
			([key, entry]) => [key, redactStringLeaves(entry)] as const,
		);
		return Object.fromEntries(entries);
	}
	return value;
}
