import { isKnownFirstName, isKnownSurname, matchKnownNames } from "#/control/name-index.ts";
import { detectNamedEntities } from "#/control/ner.ts";

export const detectionTypes = [
	"address",
	"api-key",
	"card",
	"crypto-wallet",
	"email",
	"generic-secret",
	"gov-id",
	"iban",
	"ip-address",
	"person",
	"phone",
	"private-key",
	"token",
] as const;
export type DetectionType = (typeof detectionTypes)[number];

export type DetectionKind = "pii" | "secret";

export interface Span {
	end: number;
	start: number;
}

export interface Detection {
	confidence: number;
	context?: string[];
	detectorId: string;
	kind: DetectionKind;
	span: Span;
	type: DetectionType;
	validated: boolean;
	value: string;
}

interface PatternSpec {
	context?: readonly string[];
	detectorId: string;
	source: string;
	type: DetectionType;
	validate?: (value: string) => boolean;
}

const HighConfidence = 0.95;
const PersonConfidence = 0.9;
const NerConfidence = 0.85;
const SuspectConfidence = 0.5;
const ContextConfidenceBoost = 0.2;
const ContextWindowChars = 80;

const LuhnFactor = 2;
const DecimalRadix = 10;
const IbanPrefixLength = 4;
const IbanMinLength = 15;
const IbanMaxLength = 34;
const IbanModulus = 97;
const LetterBase = 55;

export function kindOf(type: DetectionType): DetectionKind {
	return type === "api-key" ||
		type === "generic-secret" ||
		type === "private-key" ||
		type === "token"
		? "secret"
		: "pii";
}

function luhnValid(digits: string): boolean {
	let sum = 0;
	let doubleNext = false;
	for (let index = digits.length - 1; index >= 0; index -= 1) {
		const char = digits[index];
		if (char === undefined) {
			continue;
		}
		let value = Number.parseInt(char, DecimalRadix);
		if (doubleNext) {
			value *= LuhnFactor;
			if (value > DecimalRadix - 1) {
				value -= DecimalRadix - 1;
			}
		}
		sum += value;
		doubleNext = !doubleNext;
	}
	return sum % DecimalRadix === 0;
}

function ibanValid(value: string): boolean {
	const normalized = value.replace(/[\s-]/g, "").toUpperCase();
	if (normalized.length < IbanMinLength || normalized.length > IbanMaxLength) {
		return false;
	}
	const rearranged = normalized.slice(IbanPrefixLength) + normalized.slice(0, IbanPrefixLength);
	let remainder = 0;
	for (const char of rearranged) {
		const digits = char >= "0" && char <= "9" ? char : String(char.charCodeAt(0) - LetterBase);
		for (const digit of digits) {
			remainder = (remainder * DecimalRadix + Number.parseInt(digit, DecimalRadix)) % IbanModulus;
		}
	}
	return remainder === 1;
}

const secretContext = [
	"auth",
	"credential",
	"hasło",
	"key",
	"klucz",
	"password",
	"secret",
	"token",
] as const;

const secretPatterns: readonly PatternSpec[] = [
	{
		context: secretContext,
		detectorId: "secret.openai-key",
		source: "sk-[A-Za-z0-9_-]{20,}",
		type: "api-key",
	},
	{
		context: secretContext,
		detectorId: "secret.stripe-key",
		source: "sk_(?:live|test)_[0-9a-zA-Z]{24,}",
		type: "api-key",
	},
	{
		context: secretContext,
		detectorId: "secret.google-key",
		source: "AIza[0-9A-Za-z_-]{35}",
		type: "api-key",
	},
	{
		context: secretContext,
		detectorId: "secret.aws-key",
		source: "(?:AKIA|ASIA)[0-9A-Z]{16}",
		type: "api-key",
	},
	{
		context: secretContext,
		detectorId: "secret.github-token",
		source: "gh[pousr]_[A-Za-z0-9]{36,}",
		type: "api-key",
	},
	{
		context: secretContext,
		detectorId: "secret.github-pat",
		source: "github_pat_[A-Za-z0-9_]{22,}",
		type: "api-key",
	},
	{
		context: secretContext,
		detectorId: "secret.slack-token",
		source: "xox[baprs]-[A-Za-z0-9-]{10,}",
		type: "api-key",
	},
	{
		context: secretContext,
		detectorId: "secret.jwt",
		source: String.raw`eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}`,
		type: "token",
	},
	{
		context: secretContext,
		detectorId: "secret.bearer",
		source: String.raw`Bearer\s+[A-Za-z0-9._~+/=-]{20,}`,
		type: "token",
	},
	{
		context: secretContext,
		detectorId: "secret.private-key",
		source: "-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
		type: "private-key",
	},
	{
		context: secretContext,
		detectorId: "secret.generic-assignment",
		source: String.raw`(?:password|passwd|secret|api[_-]?key|token|credential)\s*[:=]\s*["']?[^\s"']{8,}`,
		type: "generic-secret",
	},
	{
		context: secretContext,
		detectorId: "secret.url-credentials",
		source: String.raw`\b[a-z][a-z0-9+.-]*://[^\s/:@]+:[^\s/@]+@`,
		type: "generic-secret",
	},
];

const piiPatterns: readonly PatternSpec[] = [
	{
		context: ["contact", "e-mail", "email", "kontakt", "mail"],
		detectorId: "pii.email",
		source: String.raw`[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}`,
		type: "email",
	},
	{
		context: ["call", "mobile", "phone", "tel", "telefon"],
		detectorId: "pii.phone",
		source: String.raw`(?<![\w-])(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)|\d{2,4})[ .-]\d{3,4}[ .-]\d{3,4}(?![\w-])`,
		type: "phone",
	},
	{
		context: ["card", "credit", "cvv", "debit", "karta", "mastercard", "payment", "visa"],
		detectorId: "pii.card",
		source: String.raw`(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])`,
		type: "card",
		validate: (value) => luhnValid(value.replace(/\D/g, "")),
	},
	{
		context: ["account", "bank", "iban", "konto", "rachunek", "transfer"],
		detectorId: "pii.iban",
		source: String.raw`\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b`,
		type: "iban",
		validate: ibanValid,
	},
	{
		context: ["identity", "nip", "pesel", "social security", "ssn", "tax"],
		detectorId: "pii.ssn",
		source: String.raw`(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)`,
		type: "gov-id",
	},
	{
		context: ["addr", "host", "ip", "serwer", "server"],
		detectorId: "pii.ipv4",
		source: String.raw`\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b`,
		type: "ip-address",
	},
	{
		context: ["addr", "host", "ip", "serwer", "server"],
		detectorId: "pii.ipv6",
		source: String.raw`\b(?:[A-F0-9]{1,4}:){7}[A-F0-9]{1,4}\b|\b[A-F0-9]{1,4}(?::[A-F0-9]{1,4})*::(?:[A-F0-9]{1,4}(?::[A-F0-9]{1,4})*)?\b`,
		type: "ip-address",
	},
	{
		context: ["bitcoin", "btc", "crypto", "eth", "ethereum", "portfel", "wallet"],
		detectorId: "pii.eth-wallet",
		source: "0x[a-fA-F0-9]{40}",
		type: "crypto-wallet",
	},
	{
		context: ["bitcoin", "btc", "crypto", "portfel", "wallet"],
		detectorId: "pii.btc-wallet",
		source: String.raw`\b(?:bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b`,
		type: "crypto-wallet",
	},
];

const CapitalizedName = String.raw`\p{Lu}[\p{L}'’-]+`;
const TitleName = String.raw`\b(?:Mr|Mrs|Ms|Miss|Dr|Prof|Herr|Frau|Mme)\.?\s+`;
const TriggerName =
	"(?:my name is|My name is|my name's|My name's|i am|I am|i'm|I'm|this is|This is|nazywam się|Nazywam się|mam na imię|Mam na imię|przedstawiam się|Przedstawiam się|mein name ist|Mein name ist|je m'appelle|Je m'appelle|mi nombre es|Mi nombre es)\\s+";
const NameCapture = `(${CapitalizedName}(?:\\s+${CapitalizedName}){0,2})`;
const whitespaceRun = /\s+/u;
const titleRegex = new RegExp(`${TitleName}${NameCapture}`, "gu");
const triggerRegex = new RegExp(`${TriggerName}${NameCapture}`, "gu");

function personDetection(match: RegExpExecArray, detectorId: string): Detection | null {
	const value = match[1];
	const whole = match[0];
	const start = match.index;
	if (value === undefined || start === undefined) {
		return null;
	}
	const spanStart = start + whole.length - value.length;
	const tokens = value.split(whitespaceRun);
	const single = tokens.length === 1 ? tokens[0] : undefined;
	if (detectorId === "person.trigger") {
		const acceptable =
			tokens.length >= 2 ||
			(single !== undefined && (isKnownFirstName(single) || isKnownSurname(single)));
		if (!acceptable) {
			return null;
		}
	}
	return {
		confidence: PersonConfidence,
		detectorId,
		kind: "pii",
		span: { end: spanStart + value.length, start: spanStart },
		type: "person",
		validated: true,
		value,
	};
}

function collectPersons(text: string): Detection[] {
	const found: Detection[] = [];

	for (const match of text.matchAll(titleRegex)) {
		const detection = personDetection(match, "person.title");
		if (detection !== null) {
			found.push(detection);
		}
	}
	for (const match of text.matchAll(triggerRegex)) {
		const detection = personDetection(match, "person.trigger");
		if (detection !== null) {
			found.push(detection);
		}
	}
	for (const match of matchKnownNames(text)) {
		found.push({
			confidence: PersonConfidence,
			detectorId: "person.dictionary",
			kind: "pii",
			span: { end: match.end, start: match.start },
			type: "person",
			validated: true,
			value: match.value,
		});
	}

	return found;
}

function collectEntities(text: string): Detection[] {
	return detectNamedEntities(text).map((span) => ({
		confidence: NerConfidence,
		detectorId: span.type === "person" ? "ner.people" : "ner.addresses",
		kind: "pii" as const,
		span: { end: span.end, start: span.start },
		type: span.type,
		validated: true,
		value: span.value,
	}));
}

function contextHits(text: string, span: Span, words: readonly string[]): string[] {
	const windowStart = Math.max(0, span.start - ContextWindowChars);
	const windowEnd = Math.min(text.length, span.end + ContextWindowChars);
	const window = text.slice(windowStart, windowEnd).toLowerCase();
	const found: string[] = [];
	for (const word of words) {
		const pattern = new RegExp(`(?<![a-z0-9])${word}(?![a-z0-9])`, "u");
		if (pattern.test(window)) {
			found.push(word);
		}
	}
	return found;
}

function detectionFromMatch(
	pattern: PatternSpec,
	text: string,
	value: string,
	start: number,
): Detection {
	const span = { end: start + value.length, start };
	const validated = pattern.validate === undefined || pattern.validate(value);
	const context = pattern.context === undefined ? [] : contextHits(text, span, pattern.context);
	const base = validated ? HighConfidence : SuspectConfidence;
	const confidence = Math.min(1, base + (context.length > 0 ? ContextConfidenceBoost : 0));
	const detection: Detection = {
		confidence,
		detectorId: pattern.detectorId,
		kind: kindOf(pattern.type),
		span,
		type: pattern.type,
		validated,
		value,
	};
	if (context.length > 0) {
		detection.context = context;
	}
	return detection;
}

function collect(text: string, patterns: readonly PatternSpec[]): Detection[] {
	const found: Detection[] = [];
	for (const pattern of patterns) {
		const regex = new RegExp(pattern.source, "gi");
		for (const match of text.matchAll(regex)) {
			const value = match[0];
			const start = match.index;
			if (value === undefined || start === undefined) {
				continue;
			}
			found.push(detectionFromMatch(pattern, text, value, start));
		}
	}
	return found;
}

function withoutOverlaps(detections: readonly Detection[]): Detection[] {
	const ordered = [...detections].sort((a, b) => {
		if (a.span.start !== b.span.start) {
			return a.span.start - b.span.start;
		}
		return b.span.end - a.span.end;
	});
	const kept: Detection[] = [];
	let cursor = -1;
	for (const detection of ordered) {
		if (detection.span.start < cursor) {
			continue;
		}
		kept.push(detection);
		cursor = detection.span.end;
	}
	return kept;
}

export function detectSensitive(text: string): Detection[] {
	const all = [
		...collect(text, secretPatterns),
		...collect(text, piiPatterns),
		...collectPersons(text),
		...collectEntities(text),
	];
	return withoutOverlaps(all);
}
