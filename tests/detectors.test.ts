import { describe, expect, it } from "vitest";

import { detectSensitive } from "#/control/detectors.ts";

import {
	ApiKeyFixture,
	AwsKeyFixture,
	BearerTokenFixture,
	GitHubTokenFixture,
	JwtFixture,
	PrivateKeyHeaderFixture,
	SlackTokenFixture,
} from "./secret-fixtures.ts";

const SuspectConfidenceCeiling = 0.6;

const EmailText = "My email is alice@example.com today.";
const EmailValue = "alice@example.com";
const PhoneText = "Call +48 123 456 789 tomorrow.";
const PhoneValue = "+48 123 456 789";
const CardText = "Pay with 4111 1111 1111 1111 now.";
const CardValue = "4111 1111 1111 1111";
const GovIdText = "SSN 123-45-6789 on file.";
const GovIdValue = "123-45-6789";
const IbanText = "Send to IBAN PL61109010140000071219812874 now.";
const IbanValue = "PL61109010140000071219812874";
const ApiKeyValue = ApiKeyFixture;
const ApiKeyText = `key ${ApiKeyValue} live`;
const AwsKeyValue = AwsKeyFixture;
const AwsKeyText = `creds ${AwsKeyValue} used`;
const GitHubKeyValue = GitHubTokenFixture;
const GitHubKeyText = `token ${GitHubKeyValue}`;
const SlackKeyValue = SlackTokenFixture;
const SlackKeyText = `hook ${SlackKeyValue}`;
const JwtValue = JwtFixture;
const JwtText = `jwt ${JwtValue} end`;
const BearerValue = BearerTokenFixture;
const BearerText = `auth ${BearerValue} set`;
const PrivateKeyValue = PrivateKeyHeaderFixture;
const PrivateKeyText = `${PrivateKeyValue}\ncontent`;
const AssignmentText = "password = supersecretvalue";

function onlyDetection(text: string) {
	const detections = detectSensitive(text);
	if (detections.length !== 1) {
		throw new Error(`expected exactly one detection in: ${text}`);
	}
	return detections[0];
}

describe("secret detection", () => {
	it("reports an API key with kind secret and its exact span", () => {
		const detection = onlyDetection(ApiKeyText);
		expect(detection?.kind).toBe("secret");
		expect(detection?.type).toBe("api-key");
		expect(detection?.value).toBe(ApiKeyValue);
		expect(detection?.detectorId).toBe("secret.openai-key");
		expect(detection?.validated).toBe(true);
		expect(ApiKeyText.slice(detection?.span.start, detection?.span.end)).toBe(ApiKeyValue);
	});

	it("detects cloud and collaboration tokens", () => {
		for (const [text, value] of [
			[AwsKeyText, AwsKeyValue],
			[GitHubKeyText, GitHubKeyValue],
			[SlackKeyText, SlackKeyValue],
		] as const) {
			const detection = onlyDetection(text);
			expect(detection?.kind).toBe("secret");
			expect(detection?.value).toBe(value);
		}
	});

	it("detects bearer tokens, JWTs, private keys, and generic assignments", () => {
		expect(onlyDetection(BearerText)?.value).toBe(BearerValue);
		expect(onlyDetection(JwtText)?.value).toBe(JwtValue);
		expect(onlyDetection(PrivateKeyText)?.value).toBe(PrivateKeyValue);
		expect(onlyDetection(AssignmentText)?.type).toBe("generic-secret");
	});
});

describe("PII detection", () => {
	it("reports an email with kind pii and its exact span", () => {
		const detection = onlyDetection(EmailText);
		expect(detection?.kind).toBe("pii");
		expect(detection?.type).toBe("email");
		expect(detection?.detectorId).toBe("pii.email");
		expect(EmailText.slice(detection?.span.start, detection?.span.end)).toBe(EmailValue);
	});

	it("detects phones, cards, government IDs, and IBANs", () => {
		expect(onlyDetection(PhoneText)?.type).toBe("phone");
		expect(onlyDetection(PhoneText)?.value).toBe(PhoneValue);
		expect(onlyDetection(CardText)?.type).toBe("card");
		expect(onlyDetection(GovIdText)?.value).toBe(GovIdValue);
		const iban = onlyDetection(IbanText);
		expect(iban?.type).toBe("iban");
		expect(iban?.validated).toBe(true);
		expect(iban?.value).toBe(IbanValue);
	});

	it("prefers the longer card match over an overlapping phone match", () => {
		const detection = onlyDetection(CardText);
		expect(detection?.type).toBe("card");
		expect(detection?.value).toBe(CardValue);
		expect(detection?.validated).toBe(true);
	});
});

describe("suspect detections", () => {
	it("downgrades a card-shaped group that fails the Luhn check to a suspect", () => {
		const detection = onlyDetection("4111111111111112 appeared on file.");
		expect(detection?.type).toBe("card");
		expect(detection?.validated).toBe(false);
		expect(detection?.confidence).toBeLessThan(SuspectConfidenceCeiling);
	});

	it("downgrades an IBAN-shaped run that fails mod-97 to a suspect", () => {
		const detection = onlyDetection("Order ID1234567890123 shipped.");
		expect(detection?.type).toBe("iban");
		expect(detection?.validated).toBe(false);
	});
});

describe("negative detector cases", () => {
	it("flags nothing in benign prose", () => {
		expect(detectSensitive("The weather in Warsaw is nice today.")).toEqual([]);
	});

	it("ignores dates and unseparated digit runs", () => {
		expect(detectSensitive("Shipped on 2026-10-03 from 1234567890.")).toEqual([]);
	});

	it("ignores an email-like string without a TLD", () => {
		expect(detectSensitive("user@localhost is not routed")).toEqual([]);
	});
});
