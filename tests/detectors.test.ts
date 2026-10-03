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

describe("ported Presidio recognizers", () => {
	it("validates a PESEL with checksum and structure", () => {
		const detection = onlyDetection("My PESEL is 44051401359 on file.");
		expect(detection?.type).toBe("pesel");
		expect(detection?.value).toBe("44051401359");
		expect(detection?.validated).toBe(true);
		expect(detection?.detectorId).toBe("pii.pesel");
	});

	it("downgrades a PESEL with a bad checksum to a suspect", () => {
		const detection = onlyDetection("My PESEL is 44051401358 on file.");
		expect(detection?.type).toBe("pesel");
		expect(detection?.validated).toBe(false);
	});

	it("validates an ABA routing number with checksum", () => {
		const detection = onlyDetection("Send to routing 011401533 today.");
		expect(detection?.type).toBe("bank-account");
		expect(detection?.validated).toBe(true);
		expect(detection?.detectorId).toBe("pii.aba-plain");
	});

	it("validates the dashed ABA form", () => {
		const detection = onlyDetection("Send to routing 0114-0153-3 today.");
		expect(detection?.detectorId).toBe("pii.aba-routing");
		expect(detection?.validated).toBe(true);
	});

	it("flags passport numbers only with supporting context", () => {
		const detection = onlyDetection("Passport 123456789 ready.");
		expect(detection?.type).toBe("passport");
		expect(detection?.validated).toBe(false);
		expect(detectSensitive("Code 123456789 ready.")).toEqual([]);
	});

	it("flags driver licenses only with supporting context", () => {
		const detection = onlyDetection("Driver license D1234567 shown.");
		expect(detection?.type).toBe("driver-license");
		expect(detectSensitive("Serial D1234567 shown.")).toEqual([]);
	});

	it("flags bare bank digit runs only with supporting context", () => {
		const detection = onlyDetection("Account 23456789 active.");
		expect(detection?.type).toBe("bank-account");
		expect(detectSensitive("Order 23456789 shipped.")).toEqual([]);
	});

	it("validates UUID version and variant", () => {
		const valid = onlyDetection("Session 123e4567-e89b-12d3-a456-426614174000 started.");
		expect(valid?.type).toBe("uuid");
		expect(valid?.validated).toBe(true);
		const invalid = onlyDetection("Session 123e4567-e89b-92d3-a456-426614174000 started.");
		expect(invalid?.type).toBe("uuid");
		expect(invalid?.validated).toBe(false);
	});

	it("detects MAC addresses in both notations", () => {
		expect(onlyDetection("Device mac 00:1B:44:11:3A:B7 online.")?.type).toBe("mac-address");
		expect(onlyDetection("Interface aabb.ccdd.eeff up.")?.type).toBe("mac-address");
	});
});
