/**
 * Generic guard API handler (interaction-gateway requirement).
 *
 * Resolves the consumer key from the defined request header (multi-consumer
 * connections), validates the request shape — malformed requests are rejected
 * with a client error before any control evaluation — then routes the
 * interaction through the shared pipeline via `guardInteraction()` and answers
 * with the defined verdict and rejection shapes.
 */

import { type AuditSink, auditEvent, noopAuditSink } from "./audit.ts";
import { guardInteraction } from "./guard.ts";
import { parseInteractionRequest } from "./shape.ts";
import {
	type ConsumerResolver,
	consumerKeyFromRequest,
	type SubjectResolution,
} from "./subjects.ts";
import type { ControlPipeline } from "./types.ts";

export interface GuardApiDeps {
	audit?: AuditSink | undefined;
	consumers: ConsumerResolver;
	pipeline: ControlPipeline;
}

export async function handleGuardRequest(request: Request, deps: GuardApiDeps): Promise<Response> {
	const audit = deps.audit ?? noopAuditSink;

	const resolution = deps.consumers.resolve(consumerKeyFromRequest(request));
	const subject = resolvedSubject(resolution, audit);
	if (subject === undefined) {
		return Response.json(
			{
				control: "consumer-key",
				error: "rejected",
				reason: resolution.ok ? "rejected" : resolution.reason,
				verdict: "block",
			},
			{ status: 403 },
		);
	}

	let body: unknown = null;
	try {
		body = await request.json();
	} catch {
		body = null;
	}

	const validation = parseInteractionRequest(body, subject);
	if (!validation.ok) {
		audit.record(
			auditEvent("interaction", {
				detail: `malformed request rejected: ${validation.errors.join("; ")}`,
				subject,
			}),
		);
		return Response.json(
			{ details: validation.errors, error: "malformed_request" },
			{ status: 400 },
		);
	}

	const outcome = await guardInteraction(validation.interaction, deps.pipeline, { audit });
	if (outcome.rejection) {
		return Response.json(
			{
				control: outcome.rejection.control,
				error: outcome.verdict === "escalate" ? "escalated" : "blocked",
				verdict: outcome.verdict,
			},
			{ status: outcome.rejection.status },
		);
	}
	return Response.json({
		content: outcome.content,
		flagged: outcome.inspection.flagged,
		verdict: outcome.verdict,
	});
}

/**
 * Resolve the policy subject for the request, recording the outcome for
 * missing/unknown consumer keys. Returns `undefined` when the configured
 * default-subject behavior is rejection.
 */
function resolvedSubject(resolution: SubjectResolution, audit: AuditSink): string | undefined {
	let subject: string | undefined;
	if (!resolution.ok) {
		audit.record(
			auditEvent("interaction", {
				controlId: "consumer-key",
				detail: `consumer key rejected: ${resolution.reason}`,
				verdict: "block",
			}),
		);
	} else if (resolution.kind === "known") {
		subject = resolution.subject;
	} else {
		audit.record(
			auditEvent("interaction", {
				detail: `consumer key resolved to default subject: ${resolution.key ?? "(none)"}`,
				subject: resolution.subject,
			}),
		);
		subject = resolution.subject;
	}
	return subject;
}
