/**
 * Signature control (pipeline stage 2): deterministic matching of inbound
 * prompts, tool calls, and outbound content against the signature feed.
 *
 * Actions come from policy — per-signature override, then severity mapping,
 * defaulting to `block`. Every match records its provenance (signature id,
 * source, feed version) in the hit so audit and tuning can trace it.
 */

import type { Control, ControlResult, Interaction, RedactionSpan, Verdict } from "../types.ts";
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

const ACTION_SEVERITY: Record<SignatureAction, number> = {
	allow: 0,
	block: 3,
	escalate: 2,
	flag: 1,
	redact: 1,
};

/** Text the feed is matched against: content plus the serialized tool call when present. */
function inspectedText(interaction: Interaction): string {
	if (interaction.tool === undefined) {
		return interaction.content;
	}
	return `${interaction.content}\n${interaction.tool.name} ${JSON.stringify(interaction.tool.arguments ?? null)}`;
}

function resolveAction(
	match: { id: string; severity: SignatureSeverity },
	config: SignatureControlConfig,
): SignatureAction {
	return config.perSignatureActions[match.id] ?? config.severityActions[match.severity] ?? "block";
}

const PROVENANCE_VERSION_CHARS = 12;
const MATCH_PREVIEW_CHARS = 80;

interface ScannedMatch {
	action: SignatureAction;
	detail: string;
	placeholder: string | null;
	span: { end: number; start: number };
}

function scanEntry(
	entry: CompiledSignature,
	text: string,
	version: string,
	config: SignatureControlConfig,
): ScannedMatch | null {
	const regex = new RegExp(entry.regex.source, entry.regex.flags);
	const match = regex.exec(text);
	if (match === null || match.index === undefined) {
		return null;
	}
	const action = resolveAction(entry, config);
	return {
		action,
		detail: `${entry.id} [${entry.severity}/${entry.kind}] from ${entry.source} @${version.slice(0, PROVENANCE_VERSION_CHARS)}: ${match[0].slice(0, MATCH_PREVIEW_CHARS)}`,
		placeholder: action === "redact" ? `[SIGNATURE:${entry.id}]` : null,
		span: { end: match.index + match[0].length, start: match.index },
	};
}

function decideSignatureResult(
	scanned: readonly (ScannedMatch & { kind: string; signatureId: string })[],
): ControlResult {
	let worst: SignatureAction = "allow";
	let worstKind = "";
	const hits: string[] = [];
	const redactions: RedactionSpan[] = [];
	for (const item of scanned) {
		hits.push(item.detail);
		if (ACTION_SEVERITY[item.action] > ACTION_SEVERITY[worst]) {
			worst = item.action;
			worstKind = item.kind;
		}
		if (item.action === "redact" && item.placeholder !== null) {
			redactions.push({
				detectorId: item.signatureId,
				end: item.span.end,
				kind: item.kind,
				placeholder: item.placeholder,
				start: item.span.start,
			});
		}
	}
	if (worst === "allow") {
		return { verdict: "allow" };
	}
	const verdict: Verdict = worst === "flag" ? "allow" : worst;
	return {
		...(redactions.length > 0 ? { redactions } : {}),
		hit: {
			controlId: "signatures",
			detail: hits.join("; "),
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
			const text = inspectedText(interaction);
			const scanned: (ScannedMatch & { kind: string; signatureId: string })[] = [];
			for (const entry of entries) {
				if (!entry.enabled) {
					continue;
				}
				const found = scanEntry(entry, text, version, options.config);
				if (found !== null) {
					scanned.push({ ...found, kind: entry.kind, signatureId: entry.id });
				}
			}
			return decideSignatureResult(scanned);
		},
	};
}
