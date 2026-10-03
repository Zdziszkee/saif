import { describe, expect, it } from "bun:test";

import { detectSensitive } from "#/control/detectors.ts";
import { placeholderFor, redactSpans } from "#/control/redact.ts";

const EmailText = "Contact alice@example.com or call +48 123 456 789.";

const emptySpan = { end: 0, start: 0 };

function detectionOf(
	type: "api-key" | "email" | "gov-id" | "iban" | "phone" | "private-key" | "token",
) {
	return {
		confidence: 1,
		detectorId: "manual",
		kind: "pii" as const,
		span: emptySpan,
		type,
		validated: true,
		value: "x",
	};
}

describe("redaction", () => {
	it("replaces spans with plan-format typed placeholders and preserves surrounding content", () => {
		const detections = detectSensitive(EmailText);
		expect(redactSpans(EmailText, detections)).toBe("Contact [EMAIL] or call [PHONE].");
	});

	it("masks cards down to the last four digits", () => {
		const text = "Pay with 4111 1111 1111 1111 now.";
		expect(redactSpans(text, detectSensitive(text))).toBe("Pay with [CARD_LAST4:1111] now.");
	});

	it("uses consistent pseudonyms for repeated person names", () => {
		const text = "Jan Kowalski met Jan Kowalski and Anna Nowak.";
		expect(redactSpans(text, detectSensitive(text))).toBe(
			"[PERSON_1] met [PERSON_1] and [PERSON_2].",
		);
	});

	it("reports a placeholder per detection type", () => {
		expect(placeholderFor(detectionOf("email"), 1)).toBe("[EMAIL]");
		expect(placeholderFor(detectionOf("phone"), 1)).toBe("[PHONE]");
		expect(placeholderFor(detectionOf("gov-id"), 1)).toBe("[SSN]");
		expect(placeholderFor(detectionOf("iban"), 1)).toBe("[IBAN]");
		expect(placeholderFor(detectionOf("api-key"), 1)).toBe("[API_KEY]");
		expect(placeholderFor(detectionOf("token"), 1)).toBe("[TOKEN]");
		expect(placeholderFor(detectionOf("private-key"), 1)).toBe("[PRIVATE_KEY]");
	});

	it("returns the input unchanged when there is nothing to redact", () => {
		const text = "nothing sensitive here";
		expect(redactSpans(text, [])).toBe(text);
	});
});
