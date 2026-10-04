/**
 * Control pipeline seam and its gateway-owned runner.
 *
 * The pipeline executes the enabled control stages cheap-first and produces
 * exactly one verdict per inspected direction. The gateway owns execution
 * semantics (fail-closed on control error or timeout, `block` final, redaction
 * spans collected for enforcement). The stages themselves — deterministic
 * detection, signature feed, semantic classification, policy verdict mapping —
 * arrive with their own spec modules and are injected as {@link Control}s.
 */

import { type AuditSink, auditEvent, noopAuditSink } from "./audit.ts";
import {
	type Control,
	type ControlHit,
	type ControlPipeline,
	type ControlResult,
	type InspectionResult,
	type Interaction,
	isVerdict,
	OUTCOME_SEVERITY,
	type RedactionSpan,
	type Verdict,
} from "./types.ts";

export interface ControlPipelineOptions {
	audit?: AuditSink | undefined;
	controls: readonly Control[];
	/** Verdict applied when a control errors, times out, or is unusable. Default `block`. */
	failureVerdict?: Verdict | undefined;
	/** Per-control budget. A control exceeding it is failed, not awaited. */
	timeoutMs?: number | undefined;
}

const DEFAULT_CONTROL_TIMEOUT_MS = 10_000;

interface InspectionState {
	blockingControl: string | undefined;
	hits: ControlHit[];
	redactions: RedactionSpan[];
	verdict: Verdict;
}

type ControlOutcome = { ok: true; result: ControlResult } | { error: string; ok: false };

export function createControlPipeline(options: ControlPipelineOptions): ControlPipeline {
	const failureVerdict = options.failureVerdict ?? "block";
	const timeoutMs = options.timeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
	const audit = options.audit ?? noopAuditSink;

	return {
		async inspect(interaction: Interaction): Promise<InspectionResult> {
			const state: InspectionState = {
				blockingControl: undefined,
				hits: [],
				redactions: [],
				verdict: "allow",
			};

			for (const control of options.controls) {
				// biome-ignore lint/performance/noAwaitInLoops: controls run cheap-first, in declared order
				const outcome = await runControl(control, interaction, timeoutMs);
				if (!outcome.ok) {
					return failClosed(state, interaction, {
						audit,
						controlId: control.id,
						error: outcome.error,
						failureVerdict,
					});
				}
				mergeControlResult(state, outcome.result, control.id);
			}

			return {
				blockingControl: state.blockingControl,
				content: interaction.content,
				flagged: state.hits.some((hit) => hit.verdict === "flag"),
				hits: state.hits,
				redactions: state.redactions,
				verdict: state.verdict,
			};
		},
	};
}

function mergeControlResult(
	state: InspectionState,
	result: ControlResult,
	controlId: string,
): void {
	if (result.hit) {
		state.hits.push(result.hit);
	}
	if (result.redactions && result.redactions.length > 0) {
		state.redactions.push(...result.redactions);
	}
	if (OUTCOME_SEVERITY[result.verdict] > OUTCOME_SEVERITY[state.verdict]) {
		state.verdict = result.verdict;
		state.blockingControl = result.verdict === "allow" ? undefined : controlId;
	}
}

function failClosed(
	state: InspectionState,
	interaction: Interaction,
	failure: {
		audit: AuditSink;
		controlId: string;
		error: string;
		failureVerdict: Verdict;
	},
): InspectionResult {
	failure.audit.record(
		auditEvent("failure", {
			controlId: failure.controlId,
			detail: failure.error,
			groupId: interaction.groupId,
			interactionId: interaction.id,
			userId: interaction.userId,
			verdict: failure.failureVerdict,
		}),
	);
	let verdict: Verdict;
	let blockingControl: string | undefined;
	if (OUTCOME_SEVERITY[state.verdict] >= OUTCOME_SEVERITY[failure.failureVerdict]) {
		verdict = state.verdict;
		blockingControl = state.verdict === "allow" ? undefined : state.blockingControl;
	} else {
		verdict = failure.failureVerdict;
		blockingControl = failure.failureVerdict === "allow" ? undefined : failure.controlId;
	}
	return {
		blockingControl,
		content: interaction.content,
		failure: failure.error,
		flagged: false,
		hits: state.hits,
		redactions: state.redactions,
		verdict,
	};
}

async function runControl(
	control: Control,
	interaction: Interaction,
	timeoutMs: number,
): Promise<ControlOutcome> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const inspected = await Promise.race([
			Promise.resolve(control.inspect(interaction)),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					reject(new Error(`control timed out after ${timeoutMs}ms`));
				}, timeoutMs);
			}),
		]);
		return validateResult(inspected, interaction);
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error), ok: false };
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}

function validateResult(result: ControlResult, interaction: Interaction): ControlOutcome {
	if (!(result && isVerdict(result.verdict))) {
		return { error: "control returned an unusable result", ok: false };
	}
	const spans = result.redactions ?? [];
	for (const span of spans) {
		const usable =
			Number.isInteger(span.start) &&
			Number.isInteger(span.end) &&
			span.start >= 0 &&
			span.end <= interaction.content.length &&
			span.start < span.end;
		if (!usable) {
			return { error: "control returned an unusable redaction span", ok: false };
		}
	}
	return { ok: true, result: { ...result, redactions: spans } };
}
