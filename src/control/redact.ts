import type { Detection } from "#/control/detectors.ts";

const CardMaskLength = 4;

export function placeholderFor(detection: Detection, personIndex: number): string {
	switch (detection.type) {
		case "address":
			return "[ADDRESS]";
		case "api-key":
			return "[API_KEY]";
		case "card": {
			const digits = detection.value.replace(/\D/g, "");
			return `[CARD_LAST4:${digits.slice(-CardMaskLength)}]`;
		}
		case "crypto-wallet":
			return "[CRYPTO_WALLET]";
		case "email":
			return "[EMAIL]";
		case "generic-secret":
			return "[GENERIC_SECRET]";
		case "gov-id":
			return "[SSN]";
		case "iban":
			return "[IBAN]";
		case "ip-address":
			return "[IP_ADDRESS]";
		case "person":
			return `[PERSON_${personIndex}]`;
		case "phone":
			return "[PHONE]";
		case "private-key":
			return "[PRIVATE_KEY]";
		case "token":
			return "[TOKEN]";
		default:
			return "[REDACTED]";
	}
}

export function redactSpans(text: string, detections: readonly Detection[]): string {
	const ascending = [...detections].sort((a, b) => a.span.start - b.span.start);
	const personPlaceholders = new Map<string, string>();
	let personCount = 0;
	for (const detection of ascending) {
		if (detection.type === "person" && !personPlaceholders.has(detection.value)) {
			personCount += 1;
			personPlaceholders.set(detection.value, `[PERSON_${personCount}]`);
		}
	}

	const descending = [...ascending].reverse();
	let result = text;
	for (const detection of descending) {
		const placeholder =
			detection.type === "person"
				? (personPlaceholders.get(detection.value) ?? `[PERSON_${personCount}]`)
				: placeholderFor(detection, personCount);
		result = result.slice(0, detection.span.start) + placeholder + result.slice(detection.span.end);
	}
	return result;
}
