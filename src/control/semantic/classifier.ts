import type { AnyEvaluateAdapter, BooleanAnswer } from "@tanstack/ai";
import { decide } from "@tanstack/ai";

import { buildQuestions, validateChecks } from "./checks.ts";
import { SEMANTIC_DEFAULTS } from "./config.ts";
import {
	SemanticInvalidAnswerError,
	SemanticTimeoutError,
	SemanticUnavailableError,
} from "./errors.ts";
import { buildSemanticState } from "./state.ts";
import type {
	SemanticAnswer,
	SemanticCheck,
	SemanticClassifier,
	SemanticEvaluateOptions,
	SemanticEvidence,
	SemanticFloors,
	SemanticInput,
	SemanticMeta,
	SemanticUsage,
} from "./types.ts";

/** Sentinel used to cut an in-flight evaluation short. */
const ABORTED = Symbol("semantic:aborted");

/**
 * `decide()` reports answer-schema violations with a `decide():`-prefixed
 * message about a missing or wrongly-typed answer. Question-map violations are
 * excluded because `validateChecks()` already rejects those first.
 */
const ANSWER_CONTRACT_VIOLATION = /^decide\(\): .*(answer|missing probability|has no level)/;

/** Why an in-flight evaluation was cut short. */
type AbortCause = "timeout" | "caller";

export interface SemanticClassifierOptions {
	/** Default check set, normally `policy.controls.semantic.checks`. */
	checks: readonly SemanticCheck[];
	floors?: SemanticFloors;
	/** Truncation cap for the state sent to the model. */
	maxChars?: number;
	/** Overrides the adapter name in `meta.classifier`. */
	name?: string;
	timeoutMs?: number;
}

/** A bounded deadline shared by the `decide()` call and its abort race. */
interface Deadline {
	cause: AbortCause | undefined;
	close: () => void;
	signal: AbortSignal;
	startedAt: number;
}

/**
 * Build a `SemanticClassifier` over any evaluate adapter.
 *
 * The real Jev implementation and the unit-test double are the same code path —
 * only the adapter differs. That keeps the answer mapping under test.
 */
export function createSemanticClassifier(
	adapter: AnyEvaluateAdapter,
	options: SemanticClassifierOptions,
): SemanticClassifier {
	const defaultChecks = options.checks ?? SEMANTIC_DEFAULTS.checks;
	validateChecks(defaultChecks);

	const floors = options.floors ?? SEMANTIC_DEFAULTS.floors;
	const timeoutMs = options.timeoutMs ?? SEMANTIC_DEFAULTS.timeoutMs;
	const maxChars = options.maxChars ?? SEMANTIC_DEFAULTS.maxChars;
	const name = options.name ?? adapter.name;

	return {
		async evaluate(
			input: SemanticInput,
			evaluateOptions?: SemanticEvaluateOptions,
		): Promise<SemanticEvidence> {
			const checks = evaluateOptions?.checks ?? defaultChecks;
			validateChecks(checks);

			const questions = buildQuestions(checks);
			const state = buildSemanticState(input, { maxChars });
			const deadline = openDeadline(timeoutMs, evaluateOptions?.signal);

			try {
				// Race rather than relying on the adapter to honour the abort signal:
				// the timeout must bound evaluation even if the adapter never settles.
				const result = await Promise.race([
					decide({
						abortSignal: deadline.signal,
						adapter,
						questions,
						state,
					}),
					rejectOnAbort(deadline),
				]);

				const answers = collectAnswers(result, Object.keys(questions));
				const meta: SemanticMeta = {
					classifier: name,
					latencyMs: Date.now() - deadline.startedAt,
					model: result.meta.model,
					usage: pickUsage(result.meta.usage),
				};
				return buildEvidence(answers, floors, meta);
			} catch (error) {
				throw mapFailure(error, deadline, name, timeoutMs);
			} finally {
				deadline.close();
			}
		},
		name,
	};
}

/**
 * Open a deadline: an AbortSignal that fires on timeout or when the caller
 * cancels, plus the reason it fired.
 */
function openDeadline(timeoutMs: number, outerSignal: AbortSignal | undefined): Deadline {
	const controller = new AbortController();
	const state: { cause: AbortCause | undefined } = { cause: undefined };

	const timer = setTimeout(() => {
		state.cause = "timeout";
		controller.abort();
	}, timeoutMs);

	const onOuterAbort = () => {
		state.cause ??= "caller";
		controller.abort();
	};

	if (outerSignal !== undefined) {
		if (outerSignal.aborted) {
			state.cause = "caller";
			controller.abort();
		} else {
			outerSignal.addEventListener("abort", onOuterAbort, { once: true });
		}
	}

	return {
		get cause() {
			return state.cause;
		},
		close: () => {
			clearTimeout(timer);
			outerSignal?.removeEventListener("abort", onOuterAbort);
		},
		signal: controller.signal,
		startedAt: Date.now(),
	};
}

/**
 * Reject as soon as the deadline's signal aborts, so a non-cooperative adapter
 * cannot hold the evaluation open past its timeout.
 */
function rejectOnAbort(deadline: Deadline): Promise<never> {
	return new Promise<never>((_resolve, reject) => {
		const abort = () => reject(ABORTED);
		if (deadline.signal.aborted) {
			abort();
			return;
		}
		deadline.signal.addEventListener("abort", abort, { once: true });
	});
}

/** Map any in-flight failure onto the semantic tier's typed error contract. */
function mapFailure(error: unknown, deadline: Deadline, name: string, timeoutMs: number): Error {
	if (error instanceof SemanticInvalidAnswerError) {
		return error;
	}
	if (error instanceof SemanticTimeoutError) {
		return error;
	}
	if (error === ABORTED || deadline.cause !== undefined) {
		return deadline.cause === "timeout"
			? new SemanticTimeoutError(`semantic: ${name} did not answer within ${timeoutMs}ms`, {
					cause: error,
				})
			: new Error("semantic: evaluation aborted by caller", { cause: error });
	}
	// `decide()` rejects answers that do not match their question definition
	// before we ever see them. That is a schema-contract violation, not an
	// outage, so it must fail closed as an invalid answer.
	if (isAnswerContractViolation(error)) {
		return new SemanticInvalidAnswerError(
			`semantic: ${name} returned an answer that does not match its check definition: ${describe(error)}`,
			{ cause: error },
		);
	}
	return new SemanticUnavailableError(`semantic: ${name} failed: ${describe(error)}`, {
		cause: error,
	});
}

/**
 * `decide()` reports answer-schema violations with a `decide():`-prefixed
 * message about a missing or wrongly-typed answer. Question-map violations are
 * excluded because `validateChecks()` already rejects those first.
 */
function isAnswerContractViolation(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	return ANSWER_CONTRACT_VIOLATION.test(error.message);
}

/**
 * Convert raw `decide()` answers into the semantic answer contract, failing
 * closed on anything that does not match its declared check definition.
 */
function collectAnswers(
	result: Record<string, unknown>,
	expectedIds: readonly string[],
): Record<string, SemanticAnswer> {
	const answers: Record<string, SemanticAnswer> = {};

	for (const id of expectedIds) {
		const raw = result[id];
		if (raw === undefined) {
			throw new SemanticInvalidAnswerError(`semantic: no answer returned for check "${id}"`);
		}
		answers[id] = toBooleanAnswer(raw, id);
	}

	return answers;
}

function toBooleanAnswer(raw: unknown, id: string): SemanticAnswer {
	if (typeof raw !== "object" || raw === null) {
		throw new SemanticInvalidAnswerError(`semantic: check "${id}" returned a non-object answer`);
	}

	const answer = raw as Partial<BooleanAnswer>;
	if (answer.type !== "boolean") {
		throw new SemanticInvalidAnswerError(
			`semantic: check "${id}" is a boolean check but the answer type was "${String(answer.type)}"`,
		);
	}
	if (typeof answer.value !== "boolean") {
		throw new SemanticInvalidAnswerError(`semantic: check "${id}" answer has no boolean value`);
	}
	const probability = answer.probability;
	if (
		typeof probability !== "number" ||
		Number.isNaN(probability) ||
		probability < 0 ||
		probability > 1
	) {
		throw new SemanticInvalidAnswerError(
			`semantic: check "${id}" answer has an invalid probability`,
		);
	}

	return { probability, type: "boolean", value: answer.value };
}

/**
 * Annotate answers with the decisiveness floor. This is the whole of the
 * "uncertain outcome" rule: an answer the model is not decisive about is
 * flagged so policy can apply its uncertainty verdict instead of guessing.
 */
function buildEvidence(
	answers: Record<string, SemanticAnswer>,
	floors: SemanticFloors,
	meta: SemanticMeta,
): SemanticEvidence {
	const uncertain: Record<string, boolean> = {};
	let anyUncertain = false;

	for (const [id, answer] of Object.entries(answers)) {
		const decisiveness = Math.max(answer.probability, 1 - answer.probability);
		const isUncertain = decisiveness < floors.decisiveness;
		uncertain[id] = isUncertain;
		if (isUncertain) {
			anyUncertain = true;
		}
	}

	return { answers, anyUncertain, floors, meta, uncertain };
}

function pickUsage(usage: {
	promptTokens?: number;
	completionTokens?: number;
	totalTokens?: number;
}): SemanticUsage {
	return {
		completionTokens: usage.completionTokens ?? 0,
		promptTokens: usage.promptTokens ?? 0,
		totalTokens: usage.totalTokens ?? 0,
	};
}

function describe(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}
