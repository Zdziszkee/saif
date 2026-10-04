/**
 * Test-harness fixtures: fixed-evidence controls and a model-connection
 * double. Doubles are injected only through the test harness — the product
 * path wires real implementations.
 */

import type { AuditSink } from "#/control/audit.ts";
import { createInMemoryAuditSink } from "#/control/audit.ts";
import { type ControlPipelineOptions, createControlPipeline } from "#/control/pipeline.ts";
import {
	type ConsumerPolicy,
	type ConsumerResolver,
	createConsumerResolver,
	createIdentityResolver,
	type IdentityPolicy,
	type IdentityResolver,
} from "#/control/subjects.ts";
import type { Control, ControlPipeline, Interaction, RedactionSpan } from "#/control/types.ts";
import type { ModelConnection, ModelReply, ModelRequest } from "#/hub/model.ts";

/** Control that blocks any content containing `marker` (optionally direction-scoped). */
export function blockOn(
	marker: string,
	controlId = "fixture-block",
	direction?: Interaction["direction"],
): Control {
	return {
		id: controlId,
		inspect: (interaction: Interaction) => {
			if (direction !== undefined && interaction.direction !== direction) {
				return { verdict: "allow" };
			}
			return interaction.content.includes(marker)
				? {
						hit: { controlId, detail: `marker ${marker}`, kind: "fixture", verdict: "block" },
						verdict: "block",
					}
				: { verdict: "allow" };
		},
	};
}

/** Control that redacts every occurrence of `marker` (optionally direction-scoped). */
export function redactOn(
	marker: string,
	placeholder = "[REDACTED]",
	direction?: Interaction["direction"],
): Control {
	return {
		id: "fixture-redact",
		inspect: (interaction: Interaction) => {
			if (direction !== undefined && interaction.direction !== direction) {
				return { verdict: "allow" };
			}
			const redactions: RedactionSpan[] = [];
			let at = interaction.content.indexOf(marker);
			while (at !== -1) {
				redactions.push({
					detectorId: "fixture-redact",
					end: at + marker.length,
					kind: "fixture",
					placeholder,
					start: at,
				});
				at = interaction.content.indexOf(marker, at + marker.length);
			}
			return redactions.length > 0
				? {
						hit: { controlId: "fixture-redact", kind: "fixture", verdict: "redact" },
						redactions,
						verdict: "redact",
					}
				: { verdict: "allow" };
		},
	};
}

/** Control that escalates any content containing `marker`. */
export function escalateOn(marker: string): Control {
	return {
		id: "fixture-escalate",
		inspect: (interaction: Interaction) =>
			interaction.content.includes(marker)
				? {
						hit: { controlId: "fixture-escalate", kind: "fixture", verdict: "escalate" },
						verdict: "escalate",
					}
				: { verdict: "allow" },
	};
}

/** Control whose verdict depends on the policy subject (per-consumer divergence). */
export function blockSubject(groupId: string, marker: string): Control {
	return {
		id: "fixture-groupId",
		inspect: (interaction: Interaction) =>
			interaction.groupId === groupId && interaction.content.includes(marker)
				? {
						hit: { controlId: "fixture-groupId", kind: "fixture", verdict: "block" },
						verdict: "block",
					}
				: { verdict: "allow" },
	};
}

/** Control that errors (fail-closed territory). */
export function failingControl(message = "control exploded"): Control {
	return {
		id: "fixture-failure",
		inspect: () => {
			throw new Error(message);
		},
	};
}

/** Control that never resolves (timeout territory). */
export function hangingControl(): Control {
	return {
		id: "fixture-hang",
		inspect: () => new Promise<never>(() => undefined),
	};
}

export function pipelineWith(
	controls: readonly Control[],
	options: Omit<ControlPipelineOptions, "controls"> = {},
): ControlPipeline {
	return createControlPipeline({ ...options, controls });
}

export interface TestAudit extends AuditSink {
	events: ReturnType<typeof createInMemoryAuditSink>["events"];
}

export function auditSink(): TestAudit {
	return createInMemoryAuditSink();
}

/** Identity resolver with two known groups; anything else is rejected. */
export function identityResolver(overrides: Partial<IdentityPolicy> = {}): IdentityResolver {
	return createIdentityResolver({
		knownGroups: ["hr", "manager"],
		...overrides,
	});
}

/** Consumer resolver with two known keys under default-subject behavior. */
export function consumerResolver(overrides: Partial<ConsumerPolicy> = {}): ConsumerResolver {
	return createConsumerResolver({
		defaultSubject: "default",
		knownKeys: ["alice", "bob"],
		unknownKey: "default-subject",
		...overrides,
	});
}

export interface ModelDouble extends ModelConnection {
	requests: ModelRequest[];
}

/** Model-connection double with scripted replies and request recording. */
export function modelDouble(
	respond: (request: ModelRequest, index: number) => ModelReply,
): ModelDouble {
	const requests: ModelRequest[] = [];
	return {
		complete: (request) => {
			requests.push(request);
			return Promise.resolve(respond(request, requests.length - 1));
		},
		modelName: "model-double",
		requests,
	};
}

export function staticReply(text: string): ModelReply {
	return {
		finishReason: "stop",
		text,
		toolCalls: [],
		usage: { completionTokens: 1, promptTokens: 1, totalTokens: 2 },
	};
}

export function toolCallReply(name: string, args: unknown = {}): ModelReply {
	return {
		finishReason: "tool_calls",
		text: "",
		toolCalls: [{ arguments: JSON.stringify(args), id: `call_${name}`, name }],
		usage: { completionTokens: 1, promptTokens: 1, totalTokens: 2 },
	};
}
