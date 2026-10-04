import { describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";

import { readAuditEvents } from "#/control/audit.ts";
import { createDeterministicControl } from "#/control/deterministic/control.ts";
import { guardInteraction } from "#/control/guard.ts";
import { createControlPipeline } from "#/control/pipeline.ts";
import { detectionConfigSchema } from "#/control/policy/schema.ts";
import { createSignatureControl } from "#/control/signatures/control.ts";
import { loadSignatureFeed } from "#/control/signatures/feed.ts";
import type { Control, Interaction } from "#/control/types.ts";
import { buildSemanticControl, getAuditSink, getHubStatus } from "#/hub/runtime.ts";
import policyDocument from "../policy.json" with { type: "json" };
import feedDocument from "../signatures.json" with { type: "json" };
import { auditSink } from "./helpers/fixtures.ts";
import { withEnv, withEnvAsync } from "./semantic/helpers.ts";

const BenignPrompt = "What is the weather in Warsaw tomorrow?";

/**
 * Runtime composition without the semantic tier — the same stages
 * `buildControls()` wires when no TYPESAFE_API_KEY is configured.
 */
function pipelineWithoutSemantic(): ReturnType<typeof createControlPipeline> {
	const policy = policyDocument as unknown as {
		controls: { detection: unknown; signatures: never };
	};
	const detection = detectionConfigSchema.safeParse(policy.controls.detection);
	if (!detection.success) {
		throw new Error("shipped policy.json detection section failed validation");
	}
	const loaded = loadSignatureFeed(feedDocument);
	return createControlPipeline({
		controls: [
			createDeterministicControl(detection.data),
			createSignatureControl({
				config: policy.controls.signatures,
				getFeed: () => ({ entries: loaded.entries, version: loaded.version }),
			}),
		],
		failureVerdict: "escalate",
	});
}

function chatInteraction(content: string): Interaction {
	return { content, direction: "inbound", groupId: "test", id: "runtime-test", seam: "chat" };
}

describe("hub runtime without a TypeSafe key", () => {
	it("omits the semantic tier instead of installing a failing control", () => {
		let control: Control | null | undefined;
		withEnv("TYPESAFE_API_KEY", "", () => {
			control = buildSemanticControl();
		});
		expect(control).toBeNull();
	});

	it("lets benign traffic through with no failure recorded", async () => {
		const audit = auditSink();
		const outcome = await guardInteraction(
			chatInteraction(BenignPrompt),
			pipelineWithoutSemantic(),
			{
				audit,
			},
		);
		expect(outcome.verdict).toBe("allow");
		expect(outcome.content).toBe(BenignPrompt);
		expect(outcome.inspection.failure).toBeUndefined();
		expect(audit.events).toHaveLength(1);
	});

	it("reports the disabled semantic tier through hub status", async () => {
		await withEnvAsync("TYPESAFE_API_KEY", "", async () => {
			const status = await getHubStatus();
			expect(status.semantic.enabled).toBe(false);
			expect(status.semantic.reason).toContain("TYPESAFE_API_KEY");
			expect(status.feed.ok).toBe(true);
			expect(status.policy.version).toBe("1");
		});
	});

	it("exposes product sink events to dashboard/export readers", async () => {
		const sink = getAuditSink();
		sink.record({
			groupId: "parity-probe",
			kind: "interaction",
			timestamp: new Date().toISOString(),
			verdict: "allow",
		});
		try {
			expect(readAuditEvents(sink).some((event) => event.groupId === "parity-probe")).toBe(true);
		} finally {
			await rm("data/audit.jsonl", { force: true });
		}
	});
});
