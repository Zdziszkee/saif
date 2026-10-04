/**
 * Encoded-payload detectors for the canonicalization pipeline.
 *
 * Attackers wrap payloads in base64 / URL / hex / HTML-entity encoding and
 * ask the model to decode-and-follow. Each finder below locates candidate
 * blobs and validates the decode (strict UTF-8, printable output, minimum
 * size, never a fixpoint) so ordinary words that merely look encoded —
 * `deadbeef` decodes to invalid UTF-8 — are left alone.
 */

export interface TextBlob {
	/** Decoded payload text. */
	decoded: string;
	/** Exclusive end offset in the scanned text. */
	end: number;
	/** Inclusive start offset in the scanned text. */
	start: number;
}

const BASE64_MIN_CHARS = 8;
const DECIMAL_RADIX = 10;
const DECODED_MIN_CHARS = 4;
const ENTITY_PATTERN = /&(?:#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/g;
const HEX_PAIR_CHARS = 2;
const HEX_RUN = /\b(?:[0-9A-Fa-f]{2}){4,}\b/g;
const BASE64_RUN =
	/(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==)/g;
const PRINTABLE_TEXT = /^[\x20-\x7E\t\n]*$/;
const URL_RUN = /(?:%[0-9A-Fa-f]{2})+/g;

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
	["amp", "&"],
	["apos", "'"],
	["gt", ">"],
	["lt", "<"],
	["nbsp", " "],
	["quot", '"'],
]);

const UNICODE_MAX = 0x10_ff_ff;
const HEX_RADIX = 16;

const utf8 = new TextDecoder("utf-8", { fatal: true });

function isPlausible(original: string, decoded: string): boolean {
	return (
		decoded.length >= DECODED_MIN_CHARS && decoded !== original && PRINTABLE_TEXT.test(decoded)
	);
}

/** Lighter bar for text-oriented encodings (URL, entities): any printable change. */
function isLightPlausible(original: string, decoded: string): boolean {
	return decoded.length > 0 && decoded !== original && PRINTABLE_TEXT.test(decoded);
}

function decodeBytes(bytes: Uint8Array): string | null {
	try {
		return utf8.decode(bytes);
	} catch {
		return null;
	}
}

function decodeBase64(slice: string): string | null {
	if (slice.length < BASE64_MIN_CHARS) {
		return null;
	}
	let binary: string;
	try {
		binary = atob(slice);
	} catch {
		return null;
	}
	const bytes = Uint8Array.from(binary, (unit) => unit.charCodeAt(0));
	const decoded = decodeBytes(bytes);
	if (decoded === null || !isPlausible(slice, decoded)) {
		return null;
	}
	return decoded;
}

function decodeUrl(slice: string): string | null {
	let decoded: string;
	try {
		decoded = decodeURIComponent(slice);
	} catch {
		return null;
	}
	if (!isLightPlausible(slice, decoded)) {
		return null;
	}
	return decoded;
}

function decodeHex(slice: string): string | null {
	const values: number[] = [];
	for (let index = 0; index < slice.length; index += HEX_PAIR_CHARS) {
		const byte = Number.parseInt(slice.slice(index, index + HEX_PAIR_CHARS), HEX_RADIX);
		if (Number.isNaN(byte)) {
			return null;
		}
		values.push(byte);
	}
	const decoded = decodeBytes(Uint8Array.from(values));
	if (decoded === null || !isPlausible(slice, decoded)) {
		return null;
	}
	return decoded;
}

function decodeEntity(slice: string): string | null {
	const body = slice.slice(1, -1);
	if (body.startsWith("#x") || body.startsWith("#X")) {
		return decodeCodePoint(body.slice(2), HEX_RADIX);
	}
	if (body.startsWith("#")) {
		return decodeCodePoint(body.slice(1), DECIMAL_RADIX);
	}
	return NAMED_ENTITIES.get(body) ?? null;
}

function decodeCodePoint(digits: string, radix: number): string | null {
	if (digits.length === 0) {
		return null;
	}
	const codePoint = Number.parseInt(digits, radix);
	if (Number.isNaN(codePoint) || codePoint < 0 || codePoint > UNICODE_MAX) {
		return null;
	}
	let decoded: string;
	try {
		decoded = String.fromCodePoint(codePoint);
	} catch {
		return null;
	}
	return PRINTABLE_TEXT.test(decoded) ? decoded : null;
}

interface Candidate {
	decode: (slice: string) => string | null;
	pattern: RegExp;
}

const CANDIDATES: Candidate[] = [
	{ decode: decodeEntity, pattern: ENTITY_PATTERN },
	{ decode: decodeUrl, pattern: URL_RUN },
	{ decode: decodeHex, pattern: HEX_RUN },
	{ decode: decodeBase64, pattern: BASE64_RUN },
];

/**
 * Locate decodable blobs left to right, first decoder wins on overlap.
 * Returns an empty array when nothing validates — never throws.
 */
export function findDecodableBlobs(text: string): TextBlob[] {
	const blobs: TextBlob[] = [];
	for (const candidate of CANDIDATES) {
		const pattern = new RegExp(candidate.pattern.source, candidate.pattern.flags);
		for (const match of text.matchAll(pattern)) {
			const start = match.index;
			const matched = match[0];
			if (start === undefined || blobs.some((blob) => start < blob.end)) {
				continue;
			}
			const decoded = candidate.decode(matched);
			if (decoded !== null) {
				blobs.push({ decoded, end: start + matched.length, start });
			}
		}
	}
	blobs.sort((a, b) => a.start - b.start);
	return blobs;
}
