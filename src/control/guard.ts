/**
 * `guardInteraction()` — the SDK-style enforcement wrapper (design D1).
 *
 * Every seam (guard API route, chat seam, MCP hub tool calls) runs its traffic
 * through this wrapper: it executes the shared control pipeline and applies
 * exactly one verdict per inspected direction — `allow` forwards the content,
 * `redact` forwards only the typed-placeholder replacement, `block` and
 * `escalate` never forward and return the defined rejection shape.
 */

import { describeError } from "#/lib/errors.ts";
import { type AuditSink, auditEvent, noopAuditSink } from "./audit.ts";
import { applyRedactions, redactJson } from "./redact.ts";
import {
	type ControlPipeline,
	type InspectionResult,
	type Interaction,
	isBlockingVerdict,
	type Verdict,
} from "./types.ts";

export interface GuardRejection {
	/** Control responsible for the rejection (or `pipeline` for failures). */
	control: string;
	status: number;
	verdict: Verdict;
}

/**
 * Caller-facing error kind for a refusing verdict: `escalate` surfaces as
 * `escalated` (human review), every other refusal as `blocked`. The guard
 * API and the hub's tool rejection share this so the same verdict never
 * renders two different error strings on two seams.
 */
export function rejectionKind(verdict: Verdict): "blocked" | "escalated" {
	return verdict === "escalate" ? "escalated" : "blocked";
}

export interface GuardOutcome {
	/** Content to forward; present only for `allow` and `redact`. */
	content?: string | undefined;
	inspection: InspectionResult;
	rejection?: GuardRejection | undefined;
	verdict: Verdict;
}

export interface GuardOptions {
	audit?: AuditSink | undefined;
	/** Raw consumer key the caller presented; recorded as `"(none)"` when absent. */
	consumerKey?: string | undefined;
	/** Serialize as JSON (tool arguments/results) instead of plain text. */
	jsonContent?: boolean | undefined;
}

const REJECTION_STATUS: Record<Verdict, number> = {
	allow: 200,
	block: 403,
	escalate: 403,
	redact: 200,
};

export async function guardInteraction(
	interaction: Interaction,
	pipeline: ControlPipeline,
	options: GuardOptions = {},
): Promise<GuardOutcome> {
	const audit = options.audit ?? noopAuditSink;
	let inspection: InspectionResult;
	try {
		inspection = await pipeline.inspect(interaction);
	} catch (error) {
		const failure = describeError(error);
		inspection = {
			blockingControl: "pipeline",
			content: interaction.content,
			failure,
			flagged: false,
			hits: [],
			redactions: [],
			verdict: "block",
		};
	}

	const outcome = enforce(interaction, inspection, options.jsonContent ?? false);
	audit.record(
		auditEvent("interaction", {
			// The pipeline's blocking control covers block/escalate/redact;
			// a clean allow belongs to the pipeline as a whole, never "none".
			consumerKey: options.consumerKey ?? "(none)",
			controlId: inspection.blockingControl ?? "pipeline",
			detail: inspection.failure,
			groupId: interaction.groupId,
			interactionId: interaction.id,
			redactionCount: inspection.redactions.length,
			seam: interaction.seam,
			toolName: interaction.tool?.name,
			userId: interaction.userId,
			verdict: outcome.verdict,
		}),
	);
	return outcome;
}

function enforce(
	interaction: Interaction,
	inspection: InspectionResult,
	jsonContent: boolean,
): GuardOutcome {
	const verdict = inspection.verdict;
	if (isBlockingVerdict(verdict)) {
		return {
			inspection,
			rejection: {
				control: inspection.blockingControl ?? "pipeline",
				status: REJECTION_STATUS[verdict],
				verdict,
			},
			verdict,
		};
	}
	if (verdict === "redact") {
		const content = jsonContent
			? redactJson(interaction.content, inspection.redactions)
			: applyRedactions(interaction.content, inspection.redactions);
		return { content, inspection, verdict };
	}
	return { content: interaction.content, inspection, verdict };
}
