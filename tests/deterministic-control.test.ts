import { describe, expect, it } from "bun:test";
import type { z } from "zod";

import { createDeterministicControl } from "#/control/deterministic/control.ts";
import { guardInteraction } from "#/control/guard.ts";
import { createControlPipeline } from "#/control/pipeline.ts";
import { detectionConfigSchema } from "#/control/policy/schema.ts";
import type { Control, ControlResult, Interaction } from "#/control/types.ts";
import policyDocument from "../policy.json" with { type: "json" };

import { ApiKeyFixture } from "./secret-fixtures.ts";

type DetectionConfig = z.infer<typeof detectionConfigSchema>;

const EmailText = "Contact alice@example.com for details.";

function baseConfig(): DetectionConfig {
	return {
		builtins: {
			encodingRescan: false,
			entropyScan: false,
			genericCredentials: true,
			pii: true,
			providerSecrets: true,
		},
		defaultActions: {
			custom: "redact",
			pii: "redact",
			secret: "block",
			suspect: "flag",
		},
		rules: [],
	};
}

function interaction(
	content: string,
	direction: Interaction["direction"] = "inbound",
): Interaction {
	return { content, direction, groupId: "test", id: "test-interaction", seam: "guard-api" };
}

function inspectControl(control: Control, content: Interaction): Promise<ControlResult> {
	return Promise.resolve(control.inspect(content));
}

describe("deterministic control", () => {
	it("allows benign content without a hit", async () => {
		const control = createDeterministicControl(baseConfig());
		expect(control.id).toBe("deterministic");
		const result = await inspectControl(
			control,
			interaction("What is the weather in Warsaw tomorrow?"),
		);
		expect(result).toEqual({ verdict: "allow" });
	});

	it("blocks provider secrets under the default actions", async () => {
		const control = createDeterministicControl(baseConfig());
		const result = await inspectControl(control, interaction(`use this key ${ApiKeyFixture} now`));
		expect(result.verdict).toBe("block");
		expect(result.hit?.controlId).toBe("deterministic");
		expect(result.hit?.kind).toBe("secret.api-key");
	});

	it("redacts PII with typed placeholders and exact spans", async () => {
		const control = createDeterministicControl(baseConfig());
		const result = await inspectControl(control, interaction(EmailText));
		expect(result.verdict).toBe("redact");
		expect(result.redactions).toEqual([
			{
				detectorId: "pii.email",
				end: EmailText.indexOf("alice@example.com") + "alice@example.com".length,
				kind: "pii.email",
				placeholder: "[EMAIL]",
				start: EmailText.indexOf("alice@example.com"),
			},
		]);
	});

	it("applies policy-defined custom rules with direction scope", async () => {
		const control = createDeterministicControl({
			...baseConfig(),
			rules: [
				{
					action: "redact",
					directions: ["inbound", "outbound"],
					id: "employee-id",
					kind: "pii",
					pattern: "\\bEMP-[0-9]{6}\\b",
				},
			],
		});
		const inbound = await inspectControl(control, interaction("Badge EMP-482910 please."));
		expect(inbound.verdict).toBe("redact");
		expect(inbound.redactions?.[0]).toMatchObject({
			detectorId: "employee-id",
			kind: "pii",
			placeholder: "[CUSTOM:EMPLOYEE_ID]",
		});
	});

	it("skips custom rules outside their direction scope", async () => {
		const control = createDeterministicControl({
			...baseConfig(),
			rules: [
				{
					action: "flag",
					directions: ["outbound"],
					id: "internal-codename",
					kind: "custom",
					pattern: "\\bCONFIDENTIAL\\b",
				},
			],
		});
		expect((await inspectControl(control, interaction("CONFIDENTIAL plans"))).verdict).toBe(
			"allow",
		);
		const outbound = await inspectControl(control, interaction("CONFIDENTIAL plans", "outbound"));
		expect(outbound.verdict).toBe("allow");
		expect(outbound.hit?.verdict).toBe("flag");
	});

	it("maps unvalidated detections to the suspect action", async () => {
		const control = createDeterministicControl(baseConfig());
		const result = await inspectControl(
			control,
			interaction("Card 4111111111111112 was declined."),
		);
		expect(result.verdict).toBe("allow");
		expect(result.hit?.verdict).toBe("flag");
		expect(result.hit?.kind).toBe("pii.card");
	});

	it("drops weak digit runs without supporting context", async () => {
		const control = createDeterministicControl(baseConfig());
		expect(await inspectControl(control, interaction("Order 23456789 shipped."))).toEqual({
			verdict: "allow",
		});
	});

	it("ranks redact above flag regardless of rule order", async () => {
		const control = createDeterministicControl({
			...baseConfig(),
			rules: [
				{
					action: "flag",
					directions: ["inbound"],
					id: "flag-first",
					kind: "custom",
					pattern: "MARKER",
				},
				{
					action: "redact",
					directions: ["inbound"],
					id: "redact-second",
					kind: "custom",
					pattern: "MARKER",
				},
			],
		});
		const result = await inspectControl(control, interaction("MARKER here"));
		expect(result.verdict).toBe("redact");
		expect(result.redactions).toHaveLength(1);
	});

	it("builds from the shipped policy.json detection section", async () => {
		const document = policyDocument as unknown as { controls: { detection: unknown } };
		const parsed = detectionConfigSchema.safeParse(document.controls.detection);
		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			return;
		}
		const control = createDeterministicControl(parsed.data);
		const result = await inspectControl(control, interaction(`use this key ${ApiKeyFixture} now`));
		expect(result.verdict).toBe("block");
	});
});

describe("deterministic control in the pipeline", () => {
	it("redacts end to end through guardInteraction", async () => {
		const pipeline = createControlPipeline({
			controls: [createDeterministicControl(baseConfig())],
		});
		const outcome = await guardInteraction(interaction(EmailText), pipeline);
		expect(outcome.verdict).toBe("redact");
		expect(outcome.content).toBe("Contact [EMAIL] for details.");
	});

	it("reports the deterministic control as blocking", async () => {
		const pipeline = createControlPipeline({
			controls: [createDeterministicControl(baseConfig())],
		});
		const outcome = await guardInteraction(
			interaction(`use this key ${ApiKeyFixture} now`),
			pipeline,
		);
		expect(outcome.verdict).toBe("block");
		expect(outcome.rejection?.control).toBe("deterministic");
		expect(outcome.content).toBeUndefined();
	});
});
