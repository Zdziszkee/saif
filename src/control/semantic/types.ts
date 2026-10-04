/** Which side of the interaction is being inspected. */
export type SemanticDirection = "inbound" | "outbound";

/** Whose content is being inspected. */
export type SemanticRole = "user" | "assistant" | "tool" | "system";

/**
 * Input to the semantic tier. `content` is expected to already be redacted by the
 * deterministic tier — this module performs no detection of its own.
 */
export interface SemanticInput {
	content: string;
	direction: SemanticDirection;
	/** Carried through for the model's context, e.g. `["pii_redacted"]`. */
	flags?: readonly string[];
	role: SemanticRole;
}

/**
 * The exact allowlist object sent to the decision model. Nothing outside these
 * five fields is serialized (no history, system prompts, tool schemas, or keys).
 */
export interface SemanticState {
	content: string;
	contentLength: number;
	direction: SemanticDirection;
	flags: string[];
	role: SemanticRole;
}

/**
 * Threshold ladder for one check, per direction. A higher probability means the
 * check fired harder, so the ladder is walked from strongest action downward:
 * `block` then `redact` then `flag`, otherwise `allow`.
 */
export interface ThresholdLadder {
	block?: number | undefined;
	flag?: number | undefined;
	redact?: number | undefined;
}

/**
 * One semantic check: a single binary question put to the decision model.
 *
 * Checks are authored in the policy document, not in code. Adding one to the
 * policy's `checks` array makes it a live guardrail with no code change.
 */
export interface SemanticCheck {
	enabled: boolean;
	/** Stable identifier; becomes the answer key. Must be unique, and must not be `meta`. */
	id: string;
	/** The question wording the model evaluates, e.g. "Does this text contain insider trading information?" */
	instructions: string;
	thresholds: {
		inbound?: ThresholdLadder | undefined;
		outbound?: ThresholdLadder | undefined;
	};
	/** Only binary yes/no questions are supported. */
	type: "boolean";
}

/**
 * Answer to one binary check. Mirrors `@tanstack/ai`'s `BooleanAnswer`.
 *
 * Note: a boolean answer carries `probability` = P(true) and **no** confidence
 * value — the wire `noul` answer has none to give. Uncertainty is therefore
 * measured as *decisiveness* (`max(p, 1 - p)`), see {@link SemanticFloors}.
 */
export interface SemanticAnswer {
	/** P(the check fired). */
	probability: number;
	type: "boolean";
	/** `true` when `probability >= 0.5`. */
	value: boolean;
}

/** Floors below which an answer is treated as uncertain rather than guessed at. */
export interface SemanticFloors {
	/**
	 * Minimum decisiveness for an answer to be trusted: `max(p, 1 - p)`.
	 * Must be `>= 0.5` to mean anything; `0.65` means "at least 65% sure either way".
	 */
	decisiveness: number;
}

/** Token accounting reported by the decision model. */
export interface SemanticUsage {
	completionTokens: number;
	promptTokens: number;
	totalTokens: number;
}

export interface SemanticMeta {
	/** Which classifier produced the answers (`typesafe`, a test double's name, ...). */
	classifier: string;
	latencyMs: number;
	/** Resolved model id, e.g. `jev-latest`. */
	model: string;
	usage: SemanticUsage;
}

/**
 * Evidence for the policy engine.
 *
 * **Classification is advisory**: this type deliberately contains no verdict.
 * Only `applyPolicy()` turns these probabilities into
 * `allow | redact | block | escalate`.
 */
export interface SemanticEvidence {
	answers: Record<string, SemanticAnswer>;
	anyUncertain: boolean;
	floors: SemanticFloors;
	meta: SemanticMeta;
	/** Per-check: `true` when the answer fell below the decisiveness floor. */
	uncertain: Record<string, boolean>;
}

export interface SemanticEvaluateOptions {
	/**
	 * Checks to use for this call. Omit to use the classifier's default set.
	 * Passing them per call is how a policy hot-reload takes effect without
	 * rebuilding the classifier.
	 */
	checks?: readonly SemanticCheck[];
	signal?: AbortSignal;
}

/**
 * The seam between the semantic tier and the rest of the control layer.
 *
 * Real Jev and the unit-test double both implement this, so the pipeline cannot
 * tell them apart — and cannot accidentally depend on double-only behaviour.
 */
export interface SemanticClassifier {
	evaluate(input: SemanticInput, options?: SemanticEvaluateOptions): Promise<SemanticEvidence>;
	readonly name: string;
}
