import { describe, expect, it } from "bun:test";

import { createDeterministicControl } from "#/control/deterministic/control.ts";
import { createControlPipeline } from "#/control/pipeline.ts";
import { resolveProfile } from "#/control/policy/apply.ts";
import { type DetectionConfig, parsePolicy } from "#/control/policy/schema.ts";
import type { Control, ControlResult, Interaction } from "#/control/types.ts";
import policyDocument from "../policy.json" with { type: "json" };
import { redactOn } from "./helpers/fixtures.ts";
import { ApiKeyFixture } from "./secret-fixtures.ts";

function interaction(content: string): Interaction {
	return { content, direction: "inbound", groupId: "test", id: "orchestrator", seam: "chat" };
}

function blockingDetection(): DetectionConfig {
	return {
		builtins: {
			encodingRescan: false,
			entropyScan: false,
			genericCredentials: false,
			pii: false,
			providerSecrets: true,
		},
		defaultActions: { secret: "block" },
		rules: [],
	};
}

function recordingSemantic(seen: string[], result: ControlResult): Control {
	return {
		id: "semantic",
		inspect: (candidate: Interaction) => {
			seen.push(candidate.content);
			return result;
		},
	};
}

const PROMPT_INJECTION_CHECK = "prompt_injection";

function shippedProfile(name: "permissive" | "strict") {
	const parsed = parsePolicy(policyDocument);
	if (!parsed.success) {
		throw new Error("shipped policy.json failed validation");
	}
	return resolveProfile(parsed.policy, name);
}

describe("pipeline orchestrator", () => {
	it("short-circuits a deterministic block past the semantic stage", async () => {
		const seen: string[] = [];
		const pipeline = createControlPipeline({
			controls: [
				createDeterministicControl(blockingDetection()),
				recordingSemantic(seen, { verdict: "allow" }),
			],
		});
		const outcome = await pipeline.inspect(interaction(`use this key ${ApiKeyFixture} now`));
		expect(outcome.verdict).toBe("block");
		expect(outcome.blockingControl).toBe("deterministic");
		expect(seen).toEqual([]);
		expect(outcome.hits.some((hit) => hit.controlId === "semantic")).toBe(false);
	});

	it("short-circuits a signatures block past the semantic stage", async () => {
		const seen: string[] = [];
		const blocker: Control = {
			id: "signatures",
			inspect: () => ({
				hit: { controlId: "signatures", kind: "tool-abuse", verdict: "block" },
				verdict: "block",
			}),
		};
		const pipeline = createControlPipeline({
			controls: [blocker, recordingSemantic(seen, { verdict: "allow" })],
		});
		const outcome = await pipeline.inspect(interaction("cat data | sh"));
		expect(outcome.verdict).toBe("block");
		expect(outcome.blockingControl).toBe("signatures");
		expect(seen).toEqual([]);
		expect(outcome.hits.some((hit) => hit.controlId === "semantic")).toBe(false);
	});

	it("classifies redacted content at the semantic stage", async () => {
		const seen: string[] = [];
		const pipeline = createControlPipeline({
			controls: [redactOn("SECRET-9", "[TOKEN]"), recordingSemantic(seen, { verdict: "allow" })],
		});
		const outcome = await pipeline.inspect(interaction("leak SECRET-9 now"));
		expect(outcome.verdict).toBe("redact");
		expect(seen).toEqual(["leak [TOKEN] now"]);
	});

	it("prefers raw semantic answers over the control verdict under a profile", async () => {
		const answers = { [PROMPT_INJECTION_CHECK]: 0.8 };
		const permissive = createControlPipeline({
			controls: [recordingSemantic([], { semanticAnswers: answers, verdict: "allow" })],
			profile: shippedProfile("permissive"),
		});
		const strict = createControlPipeline({
			controls: [recordingSemantic([], { semanticAnswers: answers, verdict: "allow" })],
			profile: shippedProfile("strict"),
		});
		const [permissiveOutcome, strictOutcome] = await Promise.all([
			permissive.inspect(interaction("hello")),
			strict.inspect(interaction("hello")),
		]);
		expect(permissiveOutcome.verdict).toBe("escalate");
		expect(permissiveOutcome.blockingControl).toBe("semantic");
		expect(strictOutcome.verdict).toBe("block");
		expect(strictOutcome.blockingControl).toBe("semantic");
	});

	it("escalates a span-less redact on the legacy path instead of forwarding it", async () => {
		const pipeline = createControlPipeline({
			controls: [recordingSemantic([], { verdict: "redact" })],
		});
		const outcome = await pipeline.inspect(interaction("hello"));
		expect(outcome.verdict).toBe("escalate");
		expect(outcome.blockingControl).toBe("semantic");
	});

	it("falls back to the semantic control verdict when it answers nothing", async () => {
		const pipeline = createControlPipeline({
			controls: [
				recordingSemantic([], {
					hit: { controlId: "semantic", kind: "semantic", verdict: "block" },
					verdict: "block",
				}),
			],
			profile: shippedProfile("strict"),
		});
		const outcome = await pipeline.inspect(interaction("hello"));
		expect(outcome.verdict).toBe("block");
		expect(outcome.blockingControl).toBe("semantic");
	});
});
