/**
 * Generic guard API handler (interaction-gateway requirement).
 *
 * Resolves caller identity from the `x-user-id` / `x-user-group-id` headers,
 * validates the request shape — malformed requests are rejected with a client
 * error before any control evaluation — then routes the interaction through the
 * shared pipeline via `guardInteraction()` and answers with the defined verdict
 * and rejection shapes.
 *
 * A missing identity or a group the policy does not define is a rejection, not
 * a fallback: callers never inherit another caller's configuration.
 */

import { type AuditSink, auditEvent, noopAuditSink } from "./audit.ts";
import { guardInteraction } from "./guard.ts";
import { parseInteractionRequest } from "./shape.ts";
import { type IdentityResolver, identityFromRequest } from "./subjects.ts";
import type { ControlPipeline } from "./types.ts";

export interface GuardApiDeps {
	audit?: AuditSink | undefined;
	identity: IdentityResolver;
	pipeline: ControlPipeline;
}

export async function handleGuardRequest(request: Request, deps: GuardApiDeps): Promise<Response> {
	const audit = deps.audit ?? noopAuditSink;

	const presented = identityFromRequest(request);
	const resolution = deps.identity.resolve(presented.userId, presented.groupId);
	if (!resolution.ok) {
		audit.record(
			auditEvent("interaction", {
				controlId: "caller-identity",
				detail: `caller identity rejected: ${resolution.reason}`,
				groupId: resolution.groupId,
				userId: resolution.userId,
				verdict: "block",
			}),
		);
		return Response.json(
			{
				control: "caller-identity",
				error: "rejected",
				reason: resolution.reason,
				verdict: "block",
			},
			{ status: 403 },
		);
	}
	const identity = resolution.identity;

	let body: unknown = null;
	try {
		body = await request.json();
	} catch {
		body = null;
	}

	const validation = parseInteractionRequest(body, identity);
	if (!validation.ok) {
		audit.record(
			auditEvent("interaction", {
				detail: `malformed request rejected: ${validation.errors.join("; ")}`,
				groupId: identity.groupId,
				userId: identity.userId,
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
