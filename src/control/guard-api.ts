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
import type {
	ControlHit,
	ControlPipeline,
	InspectionResult,
	Interaction,
	Verdict,
} from "./types.ts";

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
	logDecision(validation.interaction, outcome.verdict, outcome.rejection?.control);
	const hits = outcome.inspection.hits.map(toHitView);
	const reasons = buildReasons(outcome.inspection);
	if (outcome.rejection) {
		return Response.json(
			{
				control: outcome.rejection.control,
				error: outcome.verdict === "escalate" ? "escalated" : "blocked",
				hits,
				reasons,
				verdict: outcome.verdict,
			},
			{ status: outcome.rejection.status },
		);
	}
	return Response.json({
		content: outcome.content,
		flagged: outcome.inspection.flagged,
		hits,
		reasons,
		verdict: outcome.verdict,
	});
}

export interface GuardHitView {
	control: string;
	detail?: string | undefined;
	engine: "feed" | "jev" | "pipeline" | "policy" | "regex";
	kind: string;
}

function toHitView(hit: ControlHit): GuardHitView {
	const view: GuardHitView = {
		control: hit.controlId,
		engine: engineOfControlId(hit.controlId),
		kind: hit.kind,
	};
	if (hit.detail !== undefined) {
		view.detail = hit.detail;
	}
	return view;
}

/**
 * Which engine produced a hit. `deterministic` is the regex tier (built-in
 * detectors + policy regex rules); `semantic` is the JEV decision model
 * (TypeSafe `decide()`); `signatures` is the signature feed; `pipeline` is
 * the collective verdict with no single control responsible (clean allows);
 * anything else is policy/plumbing. The playground renders this badge so a
 * blocked prompt or tool call shows whether regex or JEV caught it.
 */
export function engineOfControlId(controlId: string): GuardHitView["engine"] {
	if (controlId === "deterministic") {
		return "regex";
	}
	if (controlId === "semantic") {
		return "jev";
	}
	if (controlId === "signatures") {
		return "feed";
	}
	if (controlId === "pipeline") {
		return "pipeline";
	}
	return "policy";
}

/**
 * Human-readable decision reasons, in the spirit of the early `filterContent`
 * verdicts (`blockedBy: deterministic | signature` plus `matches` carrying
 * `source: owasp-llm-top10`). Each hit contributes one reason naming its
 * engine, control, OWASP/policy kind, and rule detail; each applied redaction
 * contributes what was replaced and by which placeholder.
 */
function buildReasons(inspection: InspectionResult): string[] {
	const reasons: string[] = [];
	for (const hit of inspection.hits) {
		const engine = engineOfControlId(hit.controlId);
		const detail = hit.detail !== undefined ? ` (${hit.detail})` : "";
		reasons.push(`[${engine}] ${hit.controlId}: ${hit.kind}${detail}`);
	}
	for (const span of inspection.redactions) {
		reasons.push(`[regex] redacted ${span.kind} via ${span.detectorId} as ${span.placeholder}`);
	}
	if (inspection.failure !== undefined) {
		reasons.push(`fail-closed: ${inspection.failure}`);
	}
	return reasons;
}

/**
 * One human-readable line per decision on stdout, so `bun run dev` shows
 * every playground click live. Uses `process.stdout` directly because the
 * `noConsole` lint rule bans `console.*` in `src/`; the durable trail stays
 * in the audit sink (and `data/audit.jsonl` in product wiring).
 */
function logDecision(
	interaction: Interaction,
	verdict: Verdict,
	control: string | undefined,
): void {
	process.stdout.write(
		`[guard] ${interaction.seam}/${interaction.direction} subject=${interaction.subject} -> ${verdict} (${control ?? "none"})\n`,
	);
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
