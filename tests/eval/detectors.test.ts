/**
 * Evaluation suite, part 12 — secret and PII detectors.
 *
 * Each credential family gets its own row: uploading it inbound blocks
 * with the finding that names the detector, and contact PII redacts
 * outbound instead of blocking. The near-misses at the bottom guard the
 * other side — ordinary words like "key" or "token" must not trip the
 * detectors just for showing up.
 */

import { describe, expect, it } from "bun:test";
import {
	ApiKeyFixture,
	AwsKeyFixture,
	BearerTokenFixture,
	GitHubTokenFixture,
	JwtFixture,
	PrivateKeyHeaderFixture,
	SlackTokenFixture,
} from "../secret-fixtures.ts";
import { evaluate } from "./harness.ts";

const secretCases: { finding: string; name: string; text: string }[] = [
	{ finding: "secret.api-key", name: "provider API key", text: `Deploy with ${ApiKeyFixture} now` },
	{ finding: "secret.aws-key", name: "AWS access key", text: `My key is ${AwsKeyFixture}` },
	{ finding: "secret.github-token", name: "GitHub token", text: `Use token ${GitHubTokenFixture}` },
	{ finding: "secret.jwt", name: "JWT", text: `Authenticate with ${JwtFixture}` },
	{ finding: "secret.bearer", name: "bearer token", text: `Call with ${BearerTokenFixture}` },
	{
		finding: "secret.private-key-header",
		name: "private key header",
		text: `${PrivateKeyHeaderFixture} abcdef`,
	},
	{ finding: "secret.slack-token", name: "Slack token", text: `Notify ${SlackTokenFixture}` },
];

describe("eval: credential upload blocks with the naming finding", () => {
	for (const secret of secretCases) {
		it(`blocks: ${secret.name}`, async () => {
			const { body, status } = await evaluate(secret.text);
			expect(status).toBe(403);
			expect(body.verdict).toBe("block");
			expect((body.reasons ?? []).join("\n")).toContain(secret.finding);
		});
	}
});

describe("eval: contact PII redacts outbound", () => {
	it("redacts an email address", async () => {
		const { body, status } = await evaluate("Contact alice@example.com for details.", {
			direction: "outbound",
		});
		expect(status).toBe(200);
		expect(body.verdict).toBe("redact");
		expect(body.content).toBe("Contact [EMAIL] for details.");
	});

	it("redacts a phone number", async () => {
		const { body, status } = await evaluate("Call me on +1-555-123-4567 tomorrow.", {
			direction: "outbound",
		});
		expect(status).toBe(200);
		expect(body.verdict).toBe("redact");
		expect(body.content).not.toContain("+1-555-123-4567");
	});
});

describe("eval: ordinary words do not trip the detectors", () => {
	for (const text of [
		"my key is 123",
		"the token expired yesterday",
		"version 2.0 released today",
	]) {
		it(`allows: "${text}"`, async () => {
			const { body, status } = await evaluate(text);
			expect(status).toBe(200);
			expect(body.verdict).toBe("allow");
		});
	}
});
