/**
 * Shared error-description helper.
 *
 * Six modules stringified caught errors with the same
 * `error instanceof Error ? error.message : String(error)` shape. One
 * function keeps the fallback (and its custom variants for user-facing
 * load failures) in a single place.
 */

/** Describe an unknown caught value; `fallback` replaces `String(error)`. */
export function describeError(error: unknown, fallback?: string): string {
	if (error instanceof Error) {
		return error.message;
	}
	return fallback ?? String(error);
}
