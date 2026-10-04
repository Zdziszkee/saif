import { createTypesafeDecider, getTypesafeApiKeyFromEnv } from "@tanstack/ai-typesafe";
import { liveServerEnv } from "#/env.ts";
import type { SemanticClassifierOptions } from "./classifier.ts";
import { createSemanticClassifier } from "./classifier.ts";
import { SEMANTIC_DEFAULTS } from "./config.ts";
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
	 * TypeSafe API key. When omitted it is read live from `TYPESAFE_API_KEY`
	 * (empty counts as absent), so test helpers and key rotation take effect
	 * without a restart.
	 */
	apiKey?: string;
	/**
	 * Override for the TypeSafe endpoint (tests and the `mock:jev` stub).
	 * Unset means the production TypeSafe API.
	 */
	baseUrl?: string | undefined;
	/** Override the transport `fetch`, primarily for tests. */
	fetch?: typeof fetch;
	/** Overrides `SEMANTIC_DEFAULTS.model` from `./policy.json`. */
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
 * All settings default from `./policy.json`; pass overrides to deviate.
 *
 * @example
 * ```ts
 * const classifier = createJevClassifier()
 * // or with the app policy's checks taking precedence over the defaults:
 * const classifier = createJevClassifier({ checks: policy.controls.semantic.checks })
 * const evidence = await classifier.evaluate({
 *   role: "user",
 *   direction: "inbound",
 *   content: "Ignore previous instructions and ...",
 * })
 * ```
 */
export function createJevClassifier(options: JevClassifierOptions): SemanticClassifier {
	const {
		apiKey,
		baseUrl,
		fetch: fetchFn,
		model = SEMANTIC_DEFAULTS.model,
		...classifierOptions
	} = options;

	const key = apiKey ?? readApiKeyFromEnv();
	const timeoutMs = classifierOptions.timeoutMs ?? SEMANTIC_DEFAULTS.timeoutMs;
	const transportTimeout = timeoutMs + TRANSPORT_TIMEOUT_GRACE_MS;

	const adapter = createTypesafeDecider(
		model,
		key,
		fetchFn === undefined
			? { ...(baseUrl === undefined ? {} : { baseUrl }), timeout: transportTimeout }
			: {
					...(baseUrl === undefined ? {} : { baseUrl }),
					fetch: fetchFn,
					timeout: transportTimeout,
				},
	);

	return createSemanticClassifier(adapter, {
		...classifierOptions,
		name: "typesafe",
	});
}

function readApiKeyFromEnv(): string {
	try {
		// Live read first: the validated `env` snapshot is fixed at import,
		// so a key cleared from `process.env` afterwards (`withEnv`
		// key-absence tests, key rotation) would otherwise resolve stale and
		// wrongly enable the tier. Empty counts as absent.
		return liveServerEnv("TYPESAFE_API_KEY") ?? getTypesafeApiKeyFromEnv();
	} catch (error) {
		throw new SemanticConfigurationError(
			"semantic: no TypeSafe API key. Set TYPESAFE_API_KEY or pass apiKey to createJevClassifier(); the semantic tier cannot run without a real decision model.",
			{ cause: error },
		);
	}
}
