/**
 * `guardInteraction()` — the SDK-style enforcement wrapper (design D1).
 *
 * Every seam (guard API route, chat seam, MCP hub tool calls) runs its traffic
 * through this wrapper: it executes the shared control pipeline and applies
 * exactly one verdict per inspected direction — `allow` forwards the content,
 * `redact` forwards only the typed-placeholder replacement, `block` and
 * `escalate` never forward and return the defined rejection shape.
 */

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

export interface GuardOutcome {
	/** Content to forward; present only for `allow` and `redact`. */
	content?: string | undefined;
	inspection: InspectionResult;
	rejection?: GuardRejection | undefined;
	verdict: Verdict;
}

export interface GuardOptions {
	audit?: AuditSink | undefined;
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
		const failure = error instanceof Error ? error.message : String(error);
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
			controlId: outcome.rejection?.control,
			detail: inspection.failure,
			groupId: interaction.groupId,
			interactionId: interaction.id,
			redactionCount: inspection.redactions.length,
			seam: interaction.seam,
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
