import type { Detection } from "#/control/detectors.ts";

const CardMaskLength = 4;

export interface RedactionOp {
	end: number;
	start: number;
	text: string;
}

export function placeholderFor(detection: Detection, personIndex: number): string {
	switch (detection.type) {
		case "address":
			return "[ADDRESS]";
		case "api-key":
			return "[API_KEY]";
		case "bank-account":
			return "[BANK_ACCOUNT]";
		case "card": {
			const digits = detection.value.replace(/\D/g, "");
			return `[CARD_LAST4:${digits.slice(-CardMaskLength)}]`;
		}
		case "crypto-wallet":
			return "[CRYPTO_WALLET]";
		case "driver-license":
			return "[DRIVER_LICENSE]";
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
		case "mac-address":
			return "[MAC_ADDRESS]";
		case "person":
			return `[PERSON_${personIndex}]`;
		case "passport":
			return "[PASSPORT]";
		case "pesel":
			return "[PESEL]";
		case "phone":
			return "[PHONE]";
		case "private-key":
			return "[PRIVATE_KEY]";
		case "token":
			return "[TOKEN]";
		case "uuid":
			return "[UUID]";
		default:
			return "[REDACTED]";
	}
}

export function detectionOps(detections: readonly Detection[]): RedactionOp[] {
	const ascending = [...detections].sort((a, b) => a.span.start - b.span.start);
	const personPlaceholders = new Map<string, string>();
	let personCount = 0;
	const ops: RedactionOp[] = [];
	for (const detection of ascending) {
		let placeholder: string;
		if (detection.type === "person") {
			const existing = personPlaceholders.get(detection.value);
			if (existing !== undefined) {
				placeholder = existing;
			} else {
				personCount += 1;
				placeholder = placeholderFor(detection, personCount);
				personPlaceholders.set(detection.value, placeholder);
			}
		} else {
			placeholder = placeholderFor(detection, personCount);
		}
		ops.push({ end: detection.span.end, start: detection.span.start, text: placeholder });
	}
	return ops;
}

export function applyRedactions(content: string, ops: readonly RedactionOp[]): string {
	const ascending = [...ops].sort((a, b) => {
		if (a.start !== b.start) {
			return a.start - b.start;
		}
		return b.end - a.end;
	});
	const kept: RedactionOp[] = [];
	let cursor = -1;
	for (const op of ascending) {
		if (op.start < cursor) {
			continue;
		}
		kept.push(op);
		cursor = op.end;
	}
	let result = content;
	for (const op of [...kept].reverse()) {
		result = result.slice(0, op.start) + op.text + result.slice(op.end);
	}
	return result;
}

export function redactSpans(text: string, detections: readonly Detection[]): string {
	return applyRedactions(text, detectionOps(detections));
}
