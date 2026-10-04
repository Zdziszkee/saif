/**
 * Consumer-key policy derivation from the policy document's `consumers` map:
 * policy-defined keys are known subjects of their own name; unknown and
 * missing keys follow the configured default-subject or rejection behavior.
 */
import { describe, expect, test } from "bun:test";

import { consumerPolicyFromDocument, createConsumerResolver } from "#/control/subjects.ts";

describe("consumerPolicyFromDocument", () => {
	test("policy-defined consumer keys become known subjects of the same name", () => {
		const policy = consumerPolicyFromDocument({
			alice: { profile: "standard" },
			analyst: { profile: "permissive" },
			"deploy-bot": { profile: "strict" },
		});

		expect(policy.knownKeys).toEqual(["alice", "analyst", "deploy-bot"]);
		const resolver = createConsumerResolver(policy);
		expect(resolver.resolve("alice")).toEqual({
			key: "alice",
			kind: "known",
			ok: true,
			subject: "alice",
		});
	});

	test("an unknown key falls back to the default subject, never a known one", () => {
		const resolver = createConsumerResolver(consumerPolicyFromDocument({ alice: {} }));

		const resolution = resolver.resolve("mallory");
		expect(resolution.ok).toBe(true);
		if (resolution.ok) {
			expect(resolution.kind).toBe("default-subject");
			expect(resolution.subject).toBe("default");
		}
	});

	test("unknownKey: reject refuses unknown and missing keys", () => {
		const resolver = createConsumerResolver(
			consumerPolicyFromDocument(
				{ alice: {} },
				{
					defaultSubject: "default",
					unknownKey: "reject",
				},
			),
		);

		expect(resolver.resolve("mallory").ok).toBe(false);
		expect(resolver.resolve(undefined).ok).toBe(false);
		expect(resolver.resolve("alice").ok).toBe(true);
	});

	test("an empty policy document defines no known keys", () => {
		expect(consumerPolicyFromDocument({}).knownKeys).toEqual([]);
	});
});
