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
 * Collect redactable spans from control findings.
 *
 * Deterministic and signature tiers each filtered findings for
 * `action === "redact"` with a non-null placeholder (and, for signatures,
 * a non-null span) and mapped them to {@link RedactionSpan}. The filters
 * and the mapping live here; tiers only normalize their finding shape.
 */
export interface RedactableFinding {
	readonly action: string;
	readonly detectorId: string;
	readonly kind: string;
	readonly placeholder: string | null;
	readonly span: { readonly end: number; readonly start: number } | null;
}

/** Redaction spans for every finding that carries a placeholder. */
export function redactionsFromFindings(findings: readonly RedactableFinding[]): RedactionSpan[] {
	const redactions: RedactionSpan[] = [];
	for (const finding of findings) {
		if (finding.action !== "redact" || finding.placeholder === null || finding.span === null) {
			continue;
		}
		redactions.push({
			detectorId: finding.detectorId,
			end: finding.span.end,
			kind: finding.kind,
			placeholder: finding.placeholder,
			start: finding.span.start,
		});
	}
	return redactions;
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
		// Redaction broke the JSON structure: replace every string leaf so
		// nothing sensitive survives. `content` itself may not be JSON either
		// (enforcement runs outside the inspection try), so a second
		// unparseable input fails closed to a placeholder instead of
		// throwing out of `guardInteraction`.
		try {
			return JSON.stringify(redactStringLeaves(JSON.parse(content)));
		} catch {
			return '"[REDACTED]"';
		}
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
