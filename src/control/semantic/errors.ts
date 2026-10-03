/**
 * Typed failures from the semantic tier.
 *
 * The pipeline maps these onto the policy's failure verdict (default `block`), so
 * each one names *why* the tier could not produce usable evidence.
 */

/** Policy/check configuration is unusable (e.g. no API key, empty or invalid checks). */
export class SemanticConfigurationError extends Error {
	override readonly name = "SemanticConfigurationError";
}

/** The decision model did not answer within the configured timeout. */
export class SemanticTimeoutError extends Error {
	override readonly name = "SemanticTimeoutError";
}

/** The decision model was reachable but errored, or the transport failed. */
export class SemanticUnavailableError extends Error {
	override readonly name = "SemanticUnavailableError";
}

/**
 * The decision model answered, but the answer does not match its declared check
 * definition. Fails closed: never guess at an unusable answer.
 */
export class SemanticInvalidAnswerError extends Error {
	// biome-ignore lint/security/noSecrets: class name, not a credential
	override readonly name = "SemanticInvalidAnswerError";
}
