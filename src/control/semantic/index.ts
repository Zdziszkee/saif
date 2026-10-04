/**
 * Semantic control tier (Jev).
 *
 * This is the AI-based half of the hybrid control layer. It takes text plus a
 * set of policy-authored binary checks and returns calibrated probabilities.
 * **It never returns a verdict** — only the policy engine maps evidence to
 * `allow | redact | block | escalate`.
 *
 * Import surface for the rest of the control layer:
 *
 * ```ts
 * import {
 *   createJevClassifier,
 *   buildSemanticState,
 *   type SemanticEvidence,
 * } from "#/control/semantic/index.ts";
 * ```
 *
 * The unit-test double lives in `./double.ts` and is intentionally not exported
 * here: the product path runs real Jev or it fails closed.
 */

// biome-ignore lint/performance/noBarrelFile: this file is the module's public import surface for the rest of the control layer
export {
	buildQuestions,
	enabledCheckIds,
	RESERVED_QUESTION_KEY,
	validateChecks,
} from "./checks.ts";
export {
	createSemanticClassifier,
	type SemanticClassifierOptions,
} from "./classifier.ts";
export {
	checkShapeSchema,
	checksForGroup,
	loadSemanticConfig,
	parseChecks,
	parseSemanticConfig,
	SEMANTIC_DEFAULTS,
	SEMANTIC_POLICY_PATH,
	type SemanticConfig,
} from "./config.ts";
export {
	SemanticConfigurationError,
	SemanticInvalidAnswerError,
	SemanticTimeoutError,
	SemanticUnavailableError,
} from "./errors.ts";
export {
	createJevClassifier,
	JEV_MODEL,
	type JevClassifierOptions,
} from "./jev.ts";
export {
	type BuildSemanticStateOptions,
	buildSemanticState,
	DEFAULT_MAX_CHARS,
} from "./state.ts";

export type {
	SemanticAnswer,
	SemanticCheck,
	SemanticClassifier,
	SemanticDirection,
	SemanticEvaluateOptions,
	SemanticEvidence,
	SemanticFloors,
	SemanticInput,
	SemanticMeta,
	SemanticRole,
	SemanticState,
	SemanticUsage,
	ThresholdLadder,
} from "./types.ts";
