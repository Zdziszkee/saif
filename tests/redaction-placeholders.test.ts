import { describe, expect, it } from "bun:test";

import type { DetectionType } from "#/control/deterministic/detectors.ts";
import { customPlaceholder, placeholderFor } from "#/control/deterministic/placeholders.ts";
import {
	applyRedactions,
	type RedactableFinding,
	redactionsFromFindings,
	redactJson,
} from "#/control/redact.ts";
import type { RedactionSpan } from "#/control/types.ts";

function span(start: number, end: number, placeholder: string): RedactionSpan {
	return { detectorId: "test.span", end, kind: "test", placeholder, start };
}

describe("placeholderFor", () => {
	it("maps every static detection type to its documented placeholder", () => {
		const cases: [DetectionType, string][] = [
			["address", "[ADDRESS]"],
			["api-key", "[API_KEY]"],
			["bank-account", "[BANK_ACCOUNT]"],
			["crypto-wallet", "[CRYPTO_WALLET]"],
			["driver-license", "[DRIVER_LICENSE]"],
			["email", "[EMAIL]"],
			["generic-secret", "[GENERIC_SECRET]"],
			["gov-id", "[SSN]"],
			["iban", "[IBAN]"],
			["ip-address", "[IP_ADDRESS]"],
			["mac-address", "[MAC_ADDRESS]"],
			["passport", "[PASSPORT]"],
			["pesel", "[PESEL]"],
			["phone", "[PHONE]"],
			["private-key", "[PRIVATE_KEY]"],
			["token", "[TOKEN]"],
			["uuid", "[UUID]"],
		];

		for (const [type, expected] of cases) {
			expect(placeholderFor(type, "", 0)).toBe(expected);
		}
	});

	it("keeps only the last four card digits and strips separators", () => {
		expect(placeholderFor("card", "4111 1111 1111 1111", 0)).toBe("[CARD_LAST4:1111]");
		expect(placeholderFor("card", "4111-1111-1111-1111", 0)).toBe("[CARD_LAST4:1111]");
	});

	it("embeds the person index in the placeholder", () => {
		expect(placeholderFor("person", "Ada Lovelace", 0)).toBe("[PERSON_0]");
		expect(placeholderFor("person", "Ada Lovelace", 2)).toBe("[PERSON_2]");
	});

	it("falls back to [REDACTED] for unknown types", () => {
		const unknownType = "unknown-type" as unknown as DetectionType;

		expect(placeholderFor(unknownType, "value", 0)).toBe("[REDACTED]");
	});
});

describe("customPlaceholder", () => {
	it("uppercases the rule id and replaces hyphens with underscores", () => {
		expect(customPlaceholder("pii-email")).toBe("[CUSTOM:PII_EMAIL]");
	});

	it("replaces every hyphen in long rule ids", () => {
		expect(customPlaceholder("my-custom-rule-id")).toBe("[CUSTOM:MY_CUSTOM_RULE_ID]");
	});
});

describe("applyRedactions", () => {
	it("returns content unchanged when spans are empty", () => {
		expect(applyRedactions("hello", [])).toBe("hello");
	});

	it("replaces a single span with its placeholder", () => {
		const content = "My email is alice@example.com today.";
		const value = "alice@example.com";
		const start = content.indexOf(value);

		const actual = applyRedactions(content, [span(start, start + value.length, "[EMAIL]")]);

		expect(actual).toBe("My email is [EMAIL] today.");
	});

	it("replaces multiple disjoint spans", () => {
		const content = "contact alice@example.com or +48 123 456 789";
		const email = "alice@example.com";
		const phone = "+48 123 456 789";
		const emailStart = content.indexOf(email);
		const phoneStart = content.indexOf(phone);

		const actual = applyRedactions(content, [
			span(emailStart, emailStart + email.length, "[EMAIL]"),
			span(phoneStart, phoneStart + phone.length, "[PHONE]"),
		]);

		expect(actual).toBe("contact [EMAIL] or [PHONE]");
	});

	it("applies out-of-order spans without shifting offsets", () => {
		const content = "contact alice@example.com or +48 123 456 789";
		const email = "alice@example.com";
		const phone = "+48 123 456 789";
		const emailStart = content.indexOf(email);
		const phoneStart = content.indexOf(phone);

		const actual = applyRedactions(content, [
			span(phoneStart, phoneStart + phone.length, "[PHONE]"),
			span(emailStart, emailStart + email.length, "[EMAIL]"),
		]);

		expect(actual).toBe("contact [EMAIL] or [PHONE]");
	});

	it("skips a span that overlaps an already-applied span", () => {
		const actual = applyRedactions("abcdef", [span(0, 4, "[FIRST]"), span(2, 6, "[SECOND]")]);

		expect(actual).toBe("ab[SECOND]");
	});

	it("prefers the longest span when starts coincide", () => {
		const actual = applyRedactions("abcdef", [span(0, 4, "[SHORT]"), span(0, 6, "[ALL]")]);

		expect(actual).toBe("[ALL]");
	});

	it("skips negative, out-of-range, empty, and inverted spans", () => {
		const content = "abcdef";

		const actual = applyRedactions(content, [
			span(-2, 2, "[NEGATIVE]"),
			span(0, 99, "[TOO_LONG]"),
			span(2, 2, "[EMPTY]"),
			span(4, 1, "[INVERTED]"),
		]);

		expect(actual).toBe(content);
	});
});

describe("redactJson", () => {
	it("returns redacted JSON when the structure stays valid", () => {
		const content = `{"email":"alice@example.com","age":30}`;
		const value = "alice@example.com";
		const start = content.indexOf(value);

		const actual = redactJson(content, [span(start, start + value.length, "[EMAIL]")]);

		expect(actual).toBe(`{"email":"[EMAIL]","age":30}`);
	});

	it("returns JSON unchanged when spans are empty", () => {
		expect(redactJson(`{"a":1}`, [])).toBe(`{"a":1}`);
	});

	it("replaces every string leaf when redaction breaks the object shape", () => {
		const content = `{"user":{"email":"alice@example.com"},"age":30,"vip":true,"nick":null}`;

		const actual = redactJson(content, [span(0, 8, "[EMAIL]")]);

		expect(actual).toBe(`{"user":{"email":"[REDACTED]"},"age":30,"vip":true,"nick":null}`);
	});

	it("replaces every string leaf when redaction breaks an array", () => {
		const content = `["alice@example.com","bob@example.com",42]`;

		const actual = redactJson(content, [span(0, 1, "X")]);

		expect(actual).toBe(`["[REDACTED]","[REDACTED]",42]`);
	});

	it("replaces a top-level JSON string when redaction breaks the shape", () => {
		const actual = redactJson(`"alice@example.com"`, [span(0, 1, "[EMAIL]")]);

		expect(actual).toBe(`"[REDACTED]"`);
	});

	it("fails closed to a placeholder when the content is not JSON", () => {
		// Enforcement runs outside the inspection try, so unparseable input
		// must never throw out of `guardInteraction`.
		expect(redactJson("not json", [])).toBe('"[REDACTED]"');
	});
});

describe("redactionsFromFindings", () => {
	function finding(overrides: Partial<RedactableFinding> = {}): RedactableFinding {
		return {
			action: "redact",
			detectorId: "test.email",
			kind: "pii.email",
			placeholder: "[EMAIL]",
			span: { end: 17, start: 0 },
			...overrides,
		};
	}

	it("maps a redact finding with a placeholder and span", () => {
		const actual = redactionsFromFindings([finding()]);

		expect(actual).toEqual([
			{ detectorId: "test.email", end: 17, kind: "pii.email", placeholder: "[EMAIL]", start: 0 },
		]);
	});

	it("skips findings whose action is not redact", () => {
		const actual = redactionsFromFindings([finding({ action: "allow" })]);

		expect(actual).toEqual([]);
	});

	it("skips findings with a null placeholder", () => {
		const actual = redactionsFromFindings([finding({ placeholder: null })]);

		expect(actual).toEqual([]);
	});

	it("skips findings with a null span", () => {
		const actual = redactionsFromFindings([finding({ span: null })]);

		expect(actual).toEqual([]);
	});

	it("keeps only the redactable findings in a mixed batch", () => {
		const keep = finding();
		const actual = redactionsFromFindings([
			finding({ action: "block" }),
			keep,
			finding({ placeholder: null }),
			finding({ span: null }),
		]);

		expect(actual).toEqual([
			{ detectorId: "test.email", end: 17, kind: "pii.email", placeholder: "[EMAIL]", start: 0 },
		]);
	});
});
