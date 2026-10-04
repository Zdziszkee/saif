/**
 * Control pipeline seam and its gateway-owned runner (design D4).
 *
 * Cheap stages run first in declared order — allowlist, signature feed,
 * deterministic — then the semantic tier last, on content already redacted
 * by the cheap stages (redact-then-classify, so PII and secrets never reach
 * the decision model). A deterministic `block` short-circuits everything
 * after it, including the semantic call. The gateway owns execution
 * semantics (fail-closed on control error or timeout, `block` final,
 * redaction spans collected for enforcement).
 *
 * Verdict mapping has two paths: with a resolved profile the pipeline maps
 * control verdicts plus raw semantic answers through `applyPolicy()`, so
 * profile strictness decides live traffic; without one it merges control
 * verdicts directly (legacy path — identical outcomes, used by tests and
 * any wiring without policy context).
 */

import { describeError } from "#/lib/errors.ts";
import { type AuditSink, auditEvent, noopAuditSink } from "./audit.ts";
import { applyPolicy, type ResolvedProfile, type TierEvidence } from "./policy/apply.ts";
import { applyRedactions } from "./redact.ts";
import {
	type Control,
	type ControlHit,
	type ControlPipeline,
	type ControlResult,
	type InspectionResult,
	type Interaction,
	isVerdict,
	type RedactionSpan,
	type Verdict,
} from "./types.ts";
import { isMoreSevere } from "./verdicts.ts";

export interface ControlPipelineOptions {
	audit?: AuditSink | undefined;
	/** Over-budget mapping until budget state wires in (7.x). Default `block`. */
	budgetVerdict?: Verdict | undefined;
	controls: readonly Control[];
	/** Verdict applied when a control errors, times out, or is unusable. Default `block`. */
	failureVerdict?: Verdict | undefined;
	/**
	 * Resolved policy profile. Enables `applyPolicy()` mapping (profile
	 * strictness over raw semantic answers); absent, control verdicts merge
	 * directly exactly as before.
	 */
	profile?: ResolvedProfile | undefined;
	/** Per-control budget. A control exceeding it is failed, not awaited. */
	timeoutMs?: number | undefined;
}

const DEFAULT_CONTROL_TIMEOUT_MS = 10_000;

interface InspectionState {
	blockingControl: string | undefined;
	flagged: boolean;
	hits: ControlHit[];
	redactions: RedactionSpan[];
	verdict: Verdict;
}

type ControlOutcome = { ok: true; result: ControlResult } | { error: string; ok: false };

interface PipelineRun {
	audit: AuditSink;
	controls: readonly Control[];
	failureVerdict: Verdict;
	interaction: Interaction;
	seen: SeenResult[];
	semanticAnswers: Record<string, number>;
	state: InspectionState;
	timeoutMs: number;
}

export function createControlPipeline(options: ControlPipelineOptions): ControlPipeline {
	const run: Omit<PipelineRun, "interaction" | "seen" | "semanticAnswers" | "state"> = {
		audit: options.audit ?? noopAuditSink,
		controls: options.controls,
		failureVerdict: options.failureVerdict ?? "block",
		timeoutMs: options.timeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS,
	};

	return {
		async inspect(interaction: Interaction): Promise<InspectionResult> {
			const attempt: PipelineRun = {
				...run,
				interaction,
				seen: [],
				semanticAnswers: {},
				state: {
					blockingControl: undefined,
					flagged: false,
					hits: [],
					redactions: [],
					verdict: "allow",
				},
			};
			const cheapFailure = await runCheapStages(attempt);
			if (cheapFailure !== null) {
				return cheapFailure;
			}
			const semanticFailure = await runSemanticStage(attempt);
			if (semanticFailure !== null) {
				return semanticFailure;
			}
			if (options.profile === undefined) {
				return legacyResult(attempt);
			}
			return mapThroughPolicy({
				budgetVerdict: options.budgetVerdict ?? "block",
				interaction,
				profile: options.profile,
				seen: attempt.seen,
				semanticAnswers: attempt.semanticAnswers,
				state: attempt.state,
			});
		},
	};
}

/** Cheap stages in declared order; a deterministic block closes the gate behind it. */
async function runCheapStages(run: PipelineRun): Promise<InspectionResult | null> {
	for (const control of run.controls) {
		if (control.id === "semantic") {
			continue;
		}
		// biome-ignore lint/performance/noAwaitInLoops: controls run cheap-first, in declared order
		const outcome = await runControl(control, run.interaction, run.timeoutMs);
		if (!outcome.ok) {
			return failClosed(run.state, run.interaction, {
				audit: run.audit,
				controlId: control.id,
				error: outcome.error,
				failureVerdict: run.failureVerdict,
			});
		}
		mergeControlResult(run.state, outcome.result, control.id);
		run.seen.push({ control: control.id, result: outcome.result });
		if (control.id === "deterministic" && outcome.result.verdict === "block") {
			break;
		}
	}
	return null;
}

/** Semantic stage last, over content already redacted by the cheap stages. */
async function runSemanticStage(run: PipelineRun): Promise<InspectionResult | null> {
	const semanticControl = run.controls.find((control) => control.id === "semantic");
	if (semanticControl === undefined || shortCircuited(run.seen)) {
		return null;
	}
	let content = run.interaction.content;
	if (run.state.redactions.length > 0) {
		content = applyRedactions(content, run.state.redactions);
	}
	const scoped = { ...run.interaction, content };
	const outcome = await runControl(semanticControl, scoped, run.timeoutMs);
	if (!outcome.ok) {
		return failClosed(run.state, scoped, {
			audit: run.audit,
			controlId: semanticControl.id,
			error: outcome.error,
			failureVerdict: run.failureVerdict,
		});
	}
	mergeControlResult(run.state, outcome.result, semanticControl.id);
	run.seen.push({ control: semanticControl.id, result: outcome.result });
	run.semanticAnswers = outcome.result.semanticAnswers ?? {};
	return null;
}

/** Legacy merge: control verdicts combine directly, exactly as before. */
function legacyResult(run: PipelineRun): InspectionResult {
	return {
		blockingControl: run.state.blockingControl,
		content: run.interaction.content,
		flagged: run.state.flagged || run.state.hits.some((hit) => hit.verdict === "flag"),
		hits: run.state.hits,
		redactions: run.state.redactions,
		verdict: run.state.verdict,
	};
}

interface SeenResult {
	control: string;
	result: ControlResult;
}

/** True once a deterministic block has closed the gate on later stages. */
function shortCircuited(seen: readonly SeenResult[]): boolean {
	return seen.some(
		(entry) => entry.control === "deterministic" && entry.result.verdict === "block",
	);
}

function tierActionOf(result: ControlResult): TierEvidence["action"] {
	return result.verdict === "allow" && result.hit?.verdict === "flag" ? "flag" : result.verdict;
}

function mapThroughPolicy(input: {
	budgetVerdict: Verdict;
	interaction: Interaction;
	profile: ResolvedProfile;
	seen: readonly SeenResult[];
	semanticAnswers: Record<string, number>;
	state: InspectionState;
}): InspectionResult {
	const detections: TierEvidence[] = [];
	const signatures: TierEvidence[] = [];
	const other: TierEvidence[] = [];
	for (const { control, result } of input.seen) {
		if (control === "semantic") {
			// Raw answers drive the profile mapping below; the control's own
			// verdict only stands in when it answered nothing.
			if (Object.keys(input.semanticAnswers).length === 0) {
				other.push({ action: tierActionOf(result), control, kind: result.hit?.kind ?? control });
			}
			continue;
		}
		const evidence: TierEvidence = {
			action: tierActionOf(result),
			control,
			kind: result.hit?.kind ?? control,
		};
		if (control === "deterministic") {
			detections.push(evidence);
		} else if (control === "signatures") {
			signatures.push(evidence);
		} else {
			other.push(evidence);
		}
	}
	const decision = applyPolicy({
		budget: { overBudget: false, overBudgetVerdict: input.budgetVerdict },
		detections,
		direction: input.interaction.direction,
		other,
		profile: input.profile,
		semantic: input.semanticAnswers,
		signatures,
	});
	return {
		blockingControl: decision.blockingControl,
		content: input.interaction.content,
		flagged: decision.flagged || input.state.flagged,
		hits: input.state.hits,
		redactions: input.state.redactions,
		verdict: decision.verdict,
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
	if (result.flagged === true) {
		state.flagged = true;
	}
	if (result.redactions && result.redactions.length > 0) {
		state.redactions.push(...result.redactions);
	}
	if (isMoreSevere(result.verdict, state.verdict)) {
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
	if (isMoreSevere(failure.failureVerdict, state.verdict)) {
		verdict = failure.failureVerdict;
		blockingControl = failure.failureVerdict === "allow" ? undefined : failure.controlId;
	} else {
		verdict = state.verdict;
		blockingControl = state.verdict === "allow" ? undefined : state.blockingControl;
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
		return { error: describeError(error), ok: false };
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
