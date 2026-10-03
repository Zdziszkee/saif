import { describe, expect, it } from "bun:test";
import { detectSensitive } from "#/control/detectors.ts";
import { filterContent } from "#/control/filter.ts";
import { parseSignatureFeed } from "#/control/signatures.ts";
import { createPiiVault, tokenizeSpans } from "#/control/vault.ts";
import sampleFeedText from "../signatures.json?raw";

const feed = parseSignatureFeed(sampleFeedText).feed;
const SuspectConfidence = 0.5;
const TokenShape = /^\[PERSON:[0-9a-f]{12}\]$/u;

const BareCardText = "4111111111111112 appeared in the logs.";
const ContextCardText = "Card 4111111111111112 was declined at checkout.";
const IpText = "The server at 203.0.113.42 responded.";
const WalletText = "Send it to 0x52908400098527886E0F7030069857D2E4169EE7 now.";
const UrlCredsText = "The endpoint https://admin:hunter2secret@internal.example.com/api leaked.";

function onlyDetection(text: string) {
	const detections = detectSensitive(text);
	if (detections.length !== 1) {
		throw new Error(`expected exactly one detection in: ${text}`);
	}
	return detections[0];
}

describe("context-aware scoring", () => {
	it("boosts a suspect hit when supporting context words are nearby", () => {
		const bare = onlyDetection(BareCardText);
		const withContext = onlyDetection(ContextCardText);
		expect(bare?.validated).toBe(false);
		expect(withContext?.validated).toBe(false);
		expect(bare?.confidence).toBeLessThan(withContext?.confidence ?? 0);
		expect(withContext?.context).toContain("card");
	});

	it("caps validated hits at full confidence when context is present", () => {
		const withContext = onlyDetection("Email alice@example.com for contact.");
		expect(withContext?.confidence).toBe(1);
		expect(withContext?.context).toContain("email");
	});

	it("leaves confidence untouched without context words", () => {
		expect(onlyDetection(BareCardText)?.confidence).toBe(SuspectConfidence);
		expect(onlyDetection(BareCardText)?.context).toBeUndefined();
	});
});

describe("extended recognizers", () => {
	it("detects and redacts IP addresses", () => {
		const detection = onlyDetection(IpText);
		expect(detection?.type).toBe("ip-address");
		expect(detection?.value).toBe("203.0.113.42");
		const result = filterContent({ surface: "prompt", text: IpText }, { feed });
		expect(result.redactedText).toBe("The server at [IP_ADDRESS] responded.");
	});

	it("detects and redacts crypto wallet addresses", () => {
		const detection = onlyDetection(WalletText);
		expect(detection?.type).toBe("crypto-wallet");
		expect(detection?.value).toBe("0x52908400098527886E0F7030069857D2E4169EE7");
		const result = filterContent({ surface: "prompt", text: WalletText }, { feed });
		expect(result.redactedText).toBe("Send it to [CRYPTO_WALLET] now.");
	});

	it("blocks credentials embedded in URLs as a secret", () => {
		const detection = onlyDetection(UrlCredsText);
		expect(detection?.detectorId).toBe("secret.url-credentials");
		expect(detection?.kind).toBe("secret");
		const result = filterContent({ surface: "prompt", text: UrlCredsText }, { feed });
		expect(result.verdict).toBe("block");
	});
});

describe("reversible tokenization (vault)", () => {
	const vault = createPiiVault("test-vault-secret");

	it("round-trips tokenized text back to the original", () => {
		const text = "Hi, my name is Jan Kowalski and my email is jan.kowalski@example.com";
		const detections = detectSensitive(text).filter(
			(detection) => detection.type === "person" || detection.type === "email",
		);
		const tokenized = tokenizeSpans(text, detections, vault);
		expect(tokenized).not.toBe(text);
		expect(vault.untokenize(tokenized)).toBe(text);
	});

	it("uses stable tokens so the same value maps to the same token", () => {
		const vaultA = createPiiVault("test-vault-secret");
		const vaultB = createPiiVault("test-vault-secret");
		const first = vaultA.tokenFor("person", "Jan Kowalski");
		const second = vaultB.tokenFor("person", "Jan Kowalski");
		const other = vaultA.tokenFor("person", "Anna Nowak");
		expect(first).toBe(second);
		expect(first).toMatch(TokenShape);
		expect(other).not.toBe(first);
	});

	it("does not leak the original value into the token", () => {
		const token = vault.tokenFor("email", "jan.kowalski@example.com");
		expect(token).not.toContain("jan");
		expect(token).not.toContain("kowalski");
	});

	it("replaces spans through the filter in tokenize mode", () => {
		const vaultB = createPiiVault("test-vault-secret");
		const text = "Send the invoice to Anna Nowak at 42 Green Street, Warsaw";
		const result = filterContent(
			{ surface: "prompt", text },
			{ anonymization: "tokenize", feed, vault: vaultB },
		);
		expect(result.verdict).toBe("redact");
		expect(result.redactedText).not.toContain("Anna Nowak");
		expect(result.redactedText).not.toContain("42 Green Street");
		expect(vaultB.untokenize(result.redactedText)).toBe(text);
	});

	it("keeps placeholder mode as the default", () => {
		const result = filterContent(
			{ surface: "prompt", text: "Send the invoice to Anna Nowak now" },
			{ feed },
		);
		expect(result.redactedText).toBe("Send the invoice to [PERSON_1] now");
	});
});
