/**
 * Signature control (pipeline stage 2): deterministic matching of inbound
 * prompts, tool calls, and outbound content against the signature feed.
 *
 * Actions come from policy — per-signature override, then severity mapping,
 * defaulting to `block`. Every match records its provenance (signature id,
 * source, feed version) in the hit so audit and tuning can trace it.
 */

import type { Control, ControlResult, Interaction, RedactionSpan, Verdict } from "../types.ts";
import { OUTCOME_SEVERITY } from "../types.ts";
import type { CompiledSignature, SignatureFeed, SignatureSeverity } from "./feed.ts";

export type SignatureAction = "allow" | "block" | "escalate" | "flag" | "redact";

export interface SignatureControlConfig {
	enabled: boolean;
	perSignatureActions: Partial<Record<string, SignatureAction>>;
	severityActions: Record<SignatureSeverity, SignatureAction>;
}

export interface SignatureControlOptions {
	config: SignatureControlConfig;
	getFeed: () => SignatureFeed;
}

/** Text the feed is matched against: content plus the serialized tool call when present. */
function inspectedText(interaction: Interaction): { content: string; suffix: string } {
	if (interaction.tool === undefined) {
		return { content: interaction.content, suffix: "" };
	}
	return {
		content: interaction.content,
		suffix: `\n${interaction.tool.name} ${JSON.stringify(interaction.tool.arguments ?? null)}`,
	};
}

function resolveAction(
	match: { id: string; severity: SignatureSeverity },
	config: SignatureControlConfig,
): SignatureAction {
	return config.perSignatureActions[match.id] ?? config.severityActions[match.severity] ?? "block";
}

const PROVENANCE_VERSION_CHARS = 12;

interface ScannedMatch {
	action: SignatureAction;
	detail: string;
	placeholder: string | null;
	/** Null when the match lies in the tool-call suffix, outside redactable content. */
	span: { end: number; start: number } | null;
}

/**
 * Match one signature against both regions. Content matches carry spans into
 * `interaction.content` (the only text enforcement can rewrite); tool-suffix
 * matches contribute to the verdict but never produce spans — emitting
 * suffix offsets used to fail the whole control closed in pipeline
 * validation instead of enforcing honestly.
 *
 * Hit details cite the signature id, severity, kind, source, and feed
 * version. They never embed matched text: details are audited and returned
 * over the API, and echoed user content there would leak prompts into logs.
 */
function scanEntry(
	entry: CompiledSignature,
	interaction: Interaction,
	version: string,
	config: SignatureControlConfig,
): ScannedMatch[] {
	const action = resolveAction(entry, config);
	const detail = `${entry.id} [${entry.severity}/${entry.kind}] from ${entry.source} @${version.slice(0, PROVENANCE_VERSION_CHARS)}`;
	const placeholder = action === "redact" ? `[SIGNATURE:${entry.id}]` : null;
	const { content, suffix } = inspectedText(interaction);
	const matches: ScannedMatch[] = [];
	const regions: { inContent: boolean; text: string }[] = [{ inContent: true, text: content }];
	if (suffix.length > 0) {
		regions.push({ inContent: false, text: suffix });
	}
	for (const region of regions) {
		const regex = new RegExp(entry.regex.source, entry.regex.flags);
		for (const match of region.text.matchAll(regex)) {
			const start = match.index;
			if (start === undefined) {
				continue;
			}
			matches.push({
				action,
				detail,
				placeholder,
				span: region.inContent ? { end: start + match[0].length, start } : null,
			});
		}
	}
	return matches;
}

type ScannedEntry = ScannedMatch & { kind: string; signatureId: string };

function worstAction(scanned: readonly ScannedEntry[]): { action: SignatureAction; kind: string } {
	let worst: SignatureAction = "allow";
	let worstKind = "";
	for (const item of scanned) {
		if (OUTCOME_SEVERITY[item.action] > OUTCOME_SEVERITY[worst]) {
			worst = item.action;
			worstKind = item.kind;
		}
	}
	return { action: worst, kind: worstKind };
}

function hitDetails(scanned: readonly ScannedEntry[]): string {
	const details: string[] = [];
	for (const item of scanned) {
		if (!details.includes(item.detail)) {
			details.push(item.detail);
		}
	}
	return details.join("; ");
}

function contentRedactions(scanned: readonly ScannedEntry[]): RedactionSpan[] {
	const redactions: RedactionSpan[] = [];
	for (const item of scanned) {
		if (item.action !== "redact" || item.placeholder === null || item.span === null) {
			continue;
		}
		redactions.push({
			detectorId: item.signatureId,
			end: item.span.end,
			kind: item.kind,
			placeholder: item.placeholder,
			start: item.span.start,
		});
	}
	return redactions;
}

function decideSignatureResult(scanned: readonly ScannedEntry[]): ControlResult {
	const { action: worst, kind: worstKind } = worstAction(scanned);
	if (worst === "allow") {
		return { verdict: "allow" };
	}
	const details = hitDetails(scanned);
	const redactions = contentRedactions(scanned);
	if (worst === "redact" && redactions.length === 0) {
		// Every redact match lay in tool-call metadata the enforcement layer
		// cannot rewrite; a bare `redact` verdict would forward the content
		// unchanged, so refuse for review instead of failing the control.
		return {
			hit: {
				controlId: "signatures",
				detail: `${details}; matched tool-call metadata outside redactable content, escalated for review`,
				kind: worstKind,
				verdict: "escalate",
			},
			verdict: "escalate",
		};
	}
	const verdict: Verdict = worst === "flag" ? "allow" : worst;
	return {
		...(redactions.length > 0 ? { redactions } : {}),
		hit: {
			controlId: "signatures",
			detail: details,
			kind: worstKind,
			verdict: worst === "flag" ? "flag" : worst,
		},
		verdict,
	};
}

export function createSignatureControl(options: SignatureControlOptions): Control {
	return {
		id: "signatures",
		inspect: (interaction): ControlResult => {
			if (!options.config.enabled) {
				return { verdict: "allow" };
			}
			const { entries, version } = options.getFeed();
			reportStaleOverrides(options.config.perSignatureActions, entries);
			const scanned: ScannedEntry[] = [];
			for (const entry of entries) {
				if (!entry.enabled) {
					continue;
				}
				for (const found of scanEntry(entry, interaction, version, options.config)) {
					scanned.push({ ...found, kind: entry.kind, signatureId: entry.id });
				}
			}
			return decideSignatureResult(scanned);
		},
	};
}

/**
 * Fail closed on stale per-signature overrides: an override naming a
 * signature id absent from the loaded feed would otherwise silently do
 * nothing. Throwing routes through the pipeline's failure verdict instead.
 */
function reportStaleOverrides(
	overrides: SignatureControlConfig["perSignatureActions"],
	entries: readonly CompiledSignature[],
): void {
	const known = new Set(entries.map((entry) => entry.id));
	const stale = Object.keys(overrides).filter((id) => !known.has(id));
	if (stale.length > 0) {
		throw new Error(
			`signature control misconfigured: perSignatureActions names unknown signature id(s): ${stale.join(", ")}`,
		);
	}
}
