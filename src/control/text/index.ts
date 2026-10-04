/**
 * Canonical text forms for evasion-resistant matching (task 5.2).
 *
 * Attackers disguise payloads the model still understands — zero-width
 * characters, homoglyphs, leetspeak, dotted words, fullwidth forms, and
 * layered base64/URL/hex/HTML-entity encoding. This module normalizes each
 * disguise away while remembering where every normalized character came
 * from, so a match in any form maps back to a raw span the enforcement
 * layer can redact.
 *
 * This tier is deliberately dumb string surgery: cheap, deterministic, and
 * positioned before the JEV semantic tier, which owns *meaning*
 * obfuscation (paraphrase, euphemism) that no fold can catch.
 */

import { findDecodableBlobs, type TextBlob } from "./decode.ts";
import { CONFUSABLE_FOLDS, LEET_FOLDS } from "./folds.ts";

/**
 * Normalized text plus provenance: `map[i]` is the raw UTF-16 offset the
 * i-th normalized unit came from, and `rawEnd` is the raw length. Every
 * transform preserves this invariant, so offsets always resolve to the
 * original input no matter how many layers deep a match sits.
 */
export interface MappedText {
	map: number[];
	rawEnd: number;
	text: string;
}

/** Hard cap on decode layers: each layer must shrink the encoded surface, so this only bounds pathological input. */
const DEFAULT_MAX_LAYERS = 3;

const CONTROL_CHAR = /^\p{Cc}$/u;
const FORMAT_CHAR = /^\p{Cf}$/u;
const MARK_CHAR = /^\p{M}$/u;
const PUNCTUATION_OR_SYMBOL = /^[\p{P}\p{S}]$/u;
const WHITESPACE = /^\s$/u;

/** Identity mapping: every raw unit maps to itself. */
export function toMappedText(raw: string): MappedText {
	const map: number[] = [];
	for (let offset = 0; offset < raw.length; offset += 1) {
		map.push(offset);
	}
	return { map, rawEnd: raw.length, text: raw };
}

interface CanonicalAccumulator {
	chars: string[];
	map: number[];
	pendingSpace: number | undefined;
}

function flushPendingSpace(acc: CanonicalAccumulator): void {
	if (acc.pendingSpace !== undefined && acc.chars.length > 0) {
		acc.chars.push(" ");
		acc.map.push(acc.pendingSpace);
	}
	acc.pendingSpace = undefined;
}

function emitFolded(acc: CanonicalAccumulator, folded: string, src: number): void {
	for (const unit of folded) {
		const plain = LEET_FOLDS.get(unit) ?? unit;
		for (const out of plain) {
			if (WHITESPACE.test(out)) {
				acc.pendingSpace ??= src;
				continue;
			}
			if (PUNCTUATION_OR_SYMBOL.test(out)) {
				continue;
			}
			flushPendingSpace(acc);
			acc.chars.push(out);
			acc.map.push(src);
		}
	}
}

function canonicalizeUnit(acc: CanonicalAccumulator, unit: string, src: number): void {
	for (const decomposed of unit.normalize("NFKD")) {
		for (const lowered of decomposed.toLowerCase()) {
			if (CONTROL_CHAR.test(lowered) || FORMAT_CHAR.test(lowered) || MARK_CHAR.test(lowered)) {
				continue;
			}
			emitFolded(acc, CONFUSABLE_FOLDS.get(lowered) ?? lowered, src);
		}
	}
}

/**
 * Canonicalize mapped text: NFKD, drop controls/formats/marks, lowercase,
 * confusable + leet folds, drop punctuation/symbols, collapse whitespace.
 * Code points are walked (not UTF-16 units) so astral characters fold whole
 * while every emitted unit still records its raw offset.
 */
export function canonicalizeMapped(input: MappedText): MappedText {
	const acc: CanonicalAccumulator = { chars: [], map: [], pendingSpace: undefined };
	let offset = 0;
	while (offset < input.text.length) {
		const codePoint = input.text.codePointAt(offset);
		if (codePoint === undefined) {
			break;
		}
		const unit = String.fromCodePoint(codePoint);
		const src = input.map[offset] ?? input.rawEnd;
		canonicalizeUnit(acc, unit, src);
		offset += unit.length;
	}
	return { map: acc.map, rawEnd: input.rawEnd, text: acc.chars.join("") };
}

/** Canonical form of raw text. */
export function canonicalize(raw: string): MappedText {
	return canonicalizeMapped(toMappedText(raw));
}

interface SpliceTarget {
	chars: string[];
	map: number[];
}

function pushSlice(current: MappedText, out: SpliceTarget, from: number, to: number): void {
	for (let index = from; index < to; index += 1) {
		out.chars.push(current.text[index] ?? "");
		out.map.push(current.map[index] ?? current.rawEnd);
	}
}

function spliceDecoded(current: MappedText, blobs: readonly TextBlob[]): MappedText {
	const out: SpliceTarget = { chars: [], map: [] };
	let cursor = 0;
	for (const blob of blobs) {
		pushSlice(current, out, cursor, blob.start);
		const origin = rawSpan(current, blob.start, blob.end);
		for (const unit of blob.decoded) {
			out.chars.push(unit);
			out.map.push(origin.start);
		}
		cursor = blob.end;
	}
	pushSlice(current, out, cursor, current.text.length);
	return { map: out.map, rawEnd: current.rawEnd, text: out.chars.join("") };
}

/**
 * Raw decode layers over mapped text: each layer decodes every validated
 * blob (base64, URL, hex, entities) found in the previous layer. Runs on
 * un-canonicalized text on purpose — canonicalization drops the very
 * characters blobs are made of (`+`, `/`, `=`, `%`, `&`). Returns every
 * layer including the input; use {@link forms} for the match-ready set.
 */
export function decodeLayers(
	input: MappedText,
	maxLayers: number = DEFAULT_MAX_LAYERS,
): MappedText[] {
	const layers: MappedText[] = [input];
	let current = input;
	for (let layer = 0; layer < maxLayers; layer += 1) {
		const blobs = findDecodableBlobs(current.text);
		if (blobs.length === 0) {
			break;
		}
		current = spliceDecoded(current, blobs);
		layers.push(current);
	}
	return layers;
}

/**
 * Every form the matcher tries, in order: raw, canonical, then each decoded
 * layer re-canonicalized (decoded payloads may carry their own disguises).
 * Every hit in any form maps back to raw offsets via {@link rawSpan}.
 */
export function forms(raw: string, maxLayers: number = DEFAULT_MAX_LAYERS): MappedText[] {
	const base = toMappedText(raw);
	const decoded = decodeLayers(base, maxLayers).slice(1);
	return [base, canonicalizeMapped(base), ...decoded.map(canonicalizeMapped)];
}

/** Map a normalized [start, end) range back to raw offsets, clamped to bounds. */
export function rawSpan(
	mapped: MappedText,
	start: number,
	end: number,
): { end: number; start: number } {
	const length = mapped.text.length;
	const from = Math.min(Math.max(start, 0), length);
	const to = Math.min(Math.max(end, from), length);
	return {
		end: to >= length ? mapped.rawEnd : (mapped.map[to] ?? mapped.rawEnd),
		start: mapped.map[from] ?? mapped.rawEnd,
	};
}
