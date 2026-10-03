import { isKnownFirstName, isKnownSurname, matchKnownNames } from "#/control/name-index.ts";
import { detectNamedEntities } from "#/control/ner.ts";

export const detectionTypes = [
	"address",
	"api-key",
	"bank-account",
	"card",
	"crypto-wallet",
	"driver-license",
	"email",
	"generic-secret",
	"gov-id",
	"iban",
	"ip-address",
	"mac-address",
	"passport",
	"person",
	"pesel",
	"phone",
	"private-key",
	"token",
	"uuid",
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
	requiresContext?: boolean;
	score?: number;
	source: string;
	type: DetectionType;
	validate?: (value: string) => boolean;
}

const HighConfidence = 0.95;
const PersonConfidence = 0.9;
const NerConfidence = 0.85;
const SuspectConfidence = 0.5;
const WeakConfidence = 0.25;
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

const PeselWeights = "1379137913";
const PeselLength = 11;
const CheckModulus = 10;
const AbaWeights = "371371371";
const AbaLength = 9;
const UuidVersionMin = "1";
const UuidPartCount = 5;
const DigitsOnly = /^\d+$/u;
const UuidVersionMax = "8";
const UuidVariants = ["8", "9", "a", "b"] as const;

function peselValid(value: string): boolean {
	if (!DigitsOnly.test(value) || value.length !== PeselLength) {
		return false;
	}
	let sum = 0;
	for (let index = 0; index < PeselWeights.length; index += 1) {
		const digit = value[index];
		const weight = Number.parseInt(PeselWeights[index] ?? "0", DecimalRadix);
		if (digit === undefined) {
			return false;
		}
		sum += Number.parseInt(digit, DecimalRadix) * weight;
	}
	const check = value[PeselWeights.length];
	if (check === undefined) {
		return false;
	}
	return (
		(CheckModulus - (sum % CheckModulus)) % CheckModulus === Number.parseInt(check, DecimalRadix)
	);
}

function abaValid(value: string): boolean {
	const digits = value.replace(/\D/g, "");
	if (digits.length !== AbaLength) {
		return false;
	}
	let sum = 0;
	for (let index = 0; index < AbaWeights.length; index += 1) {
		const digit = digits[index];
		if (digit === undefined) {
			return false;
		}
		sum +=
			Number.parseInt(digit, DecimalRadix) *
			Number.parseInt(AbaWeights[index] ?? "0", DecimalRadix);
	}
	return sum % CheckModulus === 0;
}

function uuidValid(value: string): boolean {
	const parts = value.split("-");
	if (parts.length !== UuidPartCount) {
		return false;
	}
	const version = parts[2]?.[0];
	const variant = parts[3]?.[0]?.toLowerCase();
	if (version === undefined || variant === undefined) {
		return false;
	}
	return (
		version >= UuidVersionMin &&
		version <= UuidVersionMax &&
		(UuidVariants as readonly string[]).includes(variant)
	);
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
		detectorId: "secret.private-key-header",
		source: "-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
		type: "private-key",
	},
	{
		context: secretContext,
		detectorId: "secret.private-key",
		source: String.raw`-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----`,
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
		context: [
			"call",
			"cell",
			"cellphone",
			"mobile",
			"number",
			"phone",
			"tel",
			"telefon",
			"telephone",
		],
		detectorId: "pii.phone",
		source: String.raw`(?<![\w-])(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)|\d{2,4})[ .-]\d{3,4}[ .-]\d{3,4}(?![\w-])`,
		type: "phone",
	},
	{
		context: [
			"amex",
			"card",
			"cc",
			"credit",
			"cvv",
			"debit",
			"diners",
			"discover",
			"jcb",
			"karta",
			"mastercard",
			"payment",
			"visa",
		],
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
		context: ["numer", "pesel"],
		detectorId: "pii.pesel",
		source: String.raw`(?<!\d)[0-9]{2}(?:[02468][1-9]|[13579][012])(?:0[1-9]|1[0-9]|2[0-9]|3[01])[0-9]{5}(?!\d)`,
		type: "pesel",
		validate: peselValid,
	},
	{
		context: ["addr", "host", "ip", "ipv4", "ipv6", "serwer", "server"],
		detectorId: "pii.ipv4",
		source: String.raw`\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b`,
		type: "ip-address",
	},
	{
		context: ["addr", "host", "ip", "ipv4", "ipv6", "serwer", "server"],
		detectorId: "pii.ipv6",
		source: String.raw`\b(?:[A-F0-9]{1,4}:){7}[A-F0-9]{1,4}\b`,
		type: "ip-address",
	},
	{
		context: ["addr", "host", "ip", "ipv4", "ipv6", "serwer", "server"],
		detectorId: "pii.ipv6-compressed",
		source: String.raw`(?<![0-9A-Za-z:.])(?=[0-9A-Fa-f:.]*[0-9A-Fa-f])(?:[0-9A-Fa-f]{1,4}:)*:(?:[0-9A-Fa-f.:]*[0-9A-Fa-f:])?(?![0-9A-Za-z:]|\.[0-9A-Za-z])`,
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
	{
		context: ["document", "passport", "paszport", "travel"],
		detectorId: "pii.passport-digits",
		requiresContext: true,
		score: WeakConfidence,
		source: String.raw`\b[0-9]{9}\b`,
		type: "passport",
	},
	{
		context: ["document", "passport", "paszport", "travel"],
		detectorId: "pii.passport-nextgen",
		requiresContext: true,
		score: WeakConfidence,
		source: String.raw`\b[A-Z][0-9]{8}\b`,
		type: "passport",
	},
	{
		context: [
			"cdl",
			"dls",
			"driver",
			"driving",
			"identification",
			"lic",
			"license",
			"permit",
			"prawo jazdy",
		],
		detectorId: "pii.driver-license",
		requiresContext: true,
		score: WeakConfidence,
		source: String.raw`\b(?:[A-Z][0-9]{3,6}|[A-Z][0-9]{5,9}|[A-Z][0-9]{6,8}|[A-Z][0-9]{4,8}|[A-Z][0-9]{9,11}|[A-Z]{1,2}[0-9]{5,6}|H[0-9]{8}|V[0-9]{6}|X[0-9]{8}|[A-Z]{2}[0-9]{2,5}|[A-Z]{2}[0-9]{3,7}|[0-9]{2}[A-Z]{3}[0-9]{5,6}|[A-Z][0-9]{13,14}|[A-Z][0-9]{18}|[A-Z][0-9]{6}R|[A-Z][0-9]{9}|[A-Z][0-9]{1,12}|[0-9]{9}[A-Z]|[A-Z]{2}[0-9]{6}[A-Z]|[0-9]{8}[A-Z]{2}|[0-9]{3}[A-Z]{2}[0-9]{4}|[A-Z][0-9][A-Z][0-9][A-Z]|[0-9]{7,8}[A-Z])\b`,
		type: "driver-license",
	},
	{
		context: ["aba", "bank", "konto", "routing"],
		detectorId: "pii.aba-routing",
		source: String.raw`\b[0123678]\d{3}-\d{4}-\d\b`,
		type: "bank-account",
		validate: abaValid,
	},
	{
		context: ["aba", "bank", "konto", "routing"],
		detectorId: "pii.aba-plain",
		requiresContext: true,
		score: WeakConfidence,
		source: String.raw`\b[0123678]\d{8}\b`,
		type: "bank-account",
		validate: abaValid,
	},
	{
		context: ["account", "bank", "konto", "rachunek"],
		detectorId: "pii.bank-digits",
		requiresContext: true,
		score: WeakConfidence,
		source: String.raw`\b[0-9]{8,17}\b`,
		type: "bank-account",
	},
	{
		context: ["guid", "identifier", "uuid"],
		detectorId: "pii.uuid",
		source: String.raw`\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\b`,
		type: "uuid",
		validate: uuidValid,
	},
	{
		context: ["ethernet", "hardware", "mac"],
		detectorId: "pii.mac-colon",
		source: String.raw`\b[0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5}\b`,
		type: "mac-address",
	},
	{
		context: ["ethernet", "hardware", "mac"],
		detectorId: "pii.mac-cisco",
		source: String.raw`\b[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}\b`,
		type: "mac-address",
	},
];

const CapitalizedName = String.raw`\p{Lu}[\p{L}'’-]+`;
const TitleName = String.raw`\b(?:Mr|Mrs|Ms|Miss|Dr|Prof|Herr|Frau|Mme)\.?\s+`;
const TriggerNameStrong =
	"(?:my name is|My name is|my name's|My name's|nazywam się|Nazywam się|mam na imię|Mam na imię|przedstawiam się|Przedstawiam się|mein name ist|Mein name ist|je m'appelle|Je m'appelle|mi nombre es|Mi nombre es)\\s+";
const TriggerNameWeak = "(?:i am|I am|i'm|I'm|this is|This is)\\s+";
const NameCapture = `(${CapitalizedName}(?:\\s+${CapitalizedName}){0,2})`;
const whitespaceRun = /\s+/u;
const titleRegex = new RegExp(`${TitleName}${NameCapture}`, "gu");
const triggerStrongRegex = new RegExp(`${TriggerNameStrong}${NameCapture}`, "gu");
const triggerWeakRegex = new RegExp(`${TriggerNameWeak}${NameCapture}`, "gu");

function personDetection(
	match: RegExpExecArray,
	detectorId: string,
	weak: boolean,
): Detection | null {
	const value = match[1];
	const whole = match[0];
	const start = match.index;
	if (value === undefined || start === undefined) {
		return null;
	}
	const spanStart = start + whole.length - value.length;
	const tokens = value.split(whitespaceRun);
	const single = tokens.length === 1 ? tokens[0] : undefined;
	const first = tokens[0];
	const last = tokens.at(-1);
	const known =
		(first !== undefined && isKnownFirstName(first)) ||
		(last !== undefined && isKnownSurname(last)) ||
		(single !== undefined && isKnownFirstName(single)) ||
		(single !== undefined && isKnownSurname(single));
	const acceptable = weak ? tokens.length >= 2 && known : tokens.length >= 2 || known;
	if (!acceptable) {
		return null;
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
		const detection = personDetection(match, "person.title", false);
		if (detection !== null) {
			found.push(detection);
		}
	}
	for (const match of text.matchAll(triggerStrongRegex)) {
		const detection = personDetection(match, "person.trigger", false);
		if (detection !== null) {
			found.push(detection);
		}
	}
	for (const match of text.matchAll(triggerWeakRegex)) {
		const detection = personDetection(match, "person.trigger-weak", true);
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
): Detection | null {
	const span = { end: start + value.length, start };
	const validated =
		pattern.validate === undefined ? pattern.requiresContext !== true : pattern.validate(value);
	const context = pattern.context === undefined ? [] : contextHits(text, span, pattern.context);
	if (pattern.requiresContext === true && context.length === 0) {
		return null;
	}
	const base = validated ? HighConfidence : (pattern.score ?? SuspectConfidence);
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
			const detection = detectionFromMatch(pattern, text, value, start);
			if (detection !== null) {
				found.push(detection);
			}
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
