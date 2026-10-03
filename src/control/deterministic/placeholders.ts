import type { DetectionType } from "./detectors.ts";

const CardMaskLength = 4;
const HyphenPattern = /-/gu;

/** Typed placeholder for a detected span, per the controls documentation. */
export function placeholderFor(type: DetectionType, value: string, personIndex: number): string {
	switch (type) {
		case "address":
			return "[ADDRESS]";
		case "api-key":
			return "[API_KEY]";
		case "bank-account":
			return "[BANK_ACCOUNT]";
		case "card": {
			const digits = value.replace(/\D/g, "");
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

/** Placeholder for a policy-defined custom rule hit. */
export function customPlaceholder(ruleId: string): string {
	return `[CUSTOM:${ruleId.toUpperCase().replace(HyphenPattern, "_")}]`;
}
