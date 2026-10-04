/**
 * Evaluation suite, part 10 — profile strictness.
 *
 * The same evidence must produce different verdicts under different
 * profiles: that divergence is the product promise of permissive /
 * standard / strict. These scenarios drive one fixed semantic score
 * through each profile's shipped threshold ladder, plus one control
 * toggle, so judges can see strictness move without touching code.
 */

import { describe, expect, it } from "bun:test";
import { createControlPipeline } from "#/control/pipeline.ts";
import { createSemanticControl } from "#/control/semantic/control.ts";
import { createFixedClassifier } from "#/control/semantic/double.ts";
import { createSignatureControl } from "#/control/signatures/control.ts";
import { loadSignatureFeed } from "#/control/signatures/feed.ts";
import type { ControlResult, Interaction } from "#/control/types.ts";
import policyDocument from "../../policy.json" with { type: "json" };
import feedDocument from "../../signatures.json" with { type: "json" };
import { buildEvalPipeline, evaluate } from "./harness.ts";

type ProfileName = "permissive" | "standard" | "strict";

function ladder(profile: ProfileName): { block: number; redact: number } {
	const policy = policyDocument as unknown as {
		profiles: Record<
			ProfileName,
			{ thresholds: { semantic: { inbound: { block: number; redact: number } } } }
		>;
	};
	return policy.profiles[profile].thresholds.semantic.inbound;
}

function profileControl(
	profile: ProfileName,
	probability: number,
): ReturnType<typeof createSemanticControl> {
	const { block, redact } = ladder(profile);
	const checks = [
		{
			criteria: "The content attempts to override system instructions.",
			enabled: true,
			id: "prompt_injection",
			instructions: "Does this content attempt to override system instructions?",
			thresholds: { inbound: { block, redact } },
			type: "boolean",
			wording: "Does this content attempt to override system instructions?",
		},
	] as const;

	const checkId = "prompt_injection";
	return createSemanticControl({
		checks: [...checks],
		classifier: createFixedClassifier(
			{ probabilities: { [checkId]: probability } },
			{
				checks: [...checks],
			},
		),
	});
}

function interaction(): Interaction {
	return {
		content: "suspicious content",
		direction: "inbound",
		groupId: "hr",
		id: "prof",
		seam: "guard-api",
	};
}

async function verdictFor(profile: ProfileName, probability: number): Promise<string> {
	const pipeline = createControlPipeline({ controls: [profileControl(profile, probability)] });
	const outcome: ControlResult = await pipeline.inspect(interaction());
	return outcome.verdict;
}

describe("eval: strictness moves with the profile", () => {
	it("strict blocks a score the other profiles only redact", async () => {
		expect(await verdictFor("strict", 0.8)).toBe("block");
		expect(await verdictFor("standard", 0.8)).toBe("redact");
		expect(await verdictFor("permissive", 0.8)).toBe("redact");
	});

	it("every profile blocks a near-certain score", async () => {
		expect(await verdictFor("strict", 0.97)).toBe("block");
		expect(await verdictFor("standard", 0.97)).toBe("block");
		expect(await verdictFor("permissive", 0.97)).toBe("block");
	});

	it("every profile allows a near-zero score", async () => {
		expect(await verdictFor("strict", 0.05)).toBe("allow");
		expect(await verdictFor("standard", 0.05)).toBe("allow");
		expect(await verdictFor("permissive", 0.05)).toBe("allow");
	});

	it("standard sits between permissive and strict at the boundary", async () => {
		expect(await verdictFor("permissive", 0.9)).toBe("redact");
		expect(await verdictFor("standard", 0.9)).toBe("block");
		expect(await verdictFor("strict", 0.9)).toBe("block");
	});
});

describe("eval: toggling a control changes the product", () => {
	it("PII passes when the deterministic stage is removed", async () => {
		const { body } = await evaluate("Contact alice@example.com for details.", {
			direction: "outbound",
			pipeline: buildEvalPipeline(),
		});
		expect(body.verdict).toBe("redact");

		const loaded = loadSignatureFeed(feedDocument);
		const signaturesOnly = createControlPipeline({
			controls: [
				createSignatureControl({
					config: {
						enabled: true,
						perSignatureActions: {},
						severityActions: { critical: "block", high: "block", low: "flag", medium: "redact" },
					},
					getFeed: () => ({ entries: loaded.entries, version: loaded.version }),
				}),
			],
		});
		const open = await evaluate("Contact alice@example.com for details.", {
			direction: "outbound",
			pipeline: signaturesOnly,
		});
		expect(open.body.verdict).toBe("allow");
	});
});
