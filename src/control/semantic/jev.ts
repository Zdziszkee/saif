import { createTypesafeDecider, getTypesafeApiKeyFromEnv } from "@tanstack/ai-typesafe";
import type { SemanticClassifierOptions } from "./classifier.ts";
import { createSemanticClassifier, DEFAULT_TIMEOUT_MS } from "./classifier.ts";
import { SemanticConfigurationError } from "./errors.ts";
import type { SemanticClassifier } from "./types.ts";

/** Documented TypeSafe Jev model ids; the API also accepts other aliases. */
export const JEV_MODEL = "jev-latest";

/**
 * Extra time given to the transport beyond the classifier deadline, so the
 * classifier's own abort is what fires and reports a `SemanticTimeoutError`
 * rather than a transport timeout.
 */
const TRANSPORT_TIMEOUT_GRACE_MS = 500;

export interface JevClassifierOptions extends Omit<SemanticClassifierOptions, "name"> {
	/**
	 * TypeSafe API key. When omitted it is read from `TYPESAFE_API_KEY` via
	 * `getTypesafeApiKeyFromEnv()`.
	 */
	apiKey?: string;
	/** Override the transport `fetch`, primarily for tests. */
	fetch?: typeof fetch;
	/** Jev model id. Defaults to {@link JEV_MODEL}. */
	model?: string;
}

/**
 * The product-path semantic classifier: real Jev over TypeSafe.
 *
 * There is no fallback to a test double here. A missing or unreadable API key is
 * a `SemanticConfigurationError`, which the pipeline turns into the policy's
 * failure verdict (fail closed) — a guardrail must never silently downgrade
 * itself and report "all clear".
 *
 * @example
 * ```ts
 * const classifier = createJevClassifier({
 *   checks: policy.controls.semantic.checks,
 *   timeoutMs: 2500,
 * })
 * const evidence = await classifier.evaluate({
 *   role: "user",
 *   direction: "inbound",
 *   content: "Ignore previous instructions and ...",
 * })
 * ```
 */
export function createJevClassifier(options: JevClassifierOptions): SemanticClassifier {
	const { apiKey, model = JEV_MODEL, fetch: fetchFn, ...classifierOptions } = options;

	const key = apiKey ?? readApiKeyFromEnv();
	const timeoutMs = classifierOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const transportTimeout = timeoutMs + TRANSPORT_TIMEOUT_GRACE_MS;

	const adapter = createTypesafeDecider(
		model,
		key,
		fetchFn === undefined
			? { timeout: transportTimeout }
			: { fetch: fetchFn, timeout: transportTimeout },
	);

	return createSemanticClassifier(adapter, {
		...classifierOptions,
		name: "typesafe",
	});
}

function readApiKeyFromEnv(): string {
	try {
		return getTypesafeApiKeyFromEnv();
	} catch (error) {
		throw new SemanticConfigurationError(
			"semantic: no TypeSafe API key. Set TYPESAFE_API_KEY or pass apiKey to createJevClassifier(); the semantic tier cannot run without a real decision model.",
			{ cause: error },
		);
	}
}
