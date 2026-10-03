import type { SemanticInput, SemanticState } from "./types.ts";

/** Default cap on the content sent to the decision model. */
export const DEFAULT_MAX_CHARS = 4000;

export interface BuildSemanticStateOptions {
	maxChars?: number;
}

/**
 * Build the minimal allowlist state sent to the decision model.
 *
 * Exactly five fields are serialized — `role`, `direction`, `content`,
 * `contentLength`, `flags` — and nothing else. No conversation history, system
 * prompts, tool schemas, or credentials ever reach the model from here.
 *
 * `content` is truncated to `maxChars`; `contentLength` describes the content as
 * sent, so the state is self-consistent.
 *
 * This function performs no detection or redaction: the deterministic tier owns
 * that, and `content` is expected to arrive already redacted.
 */
export function buildSemanticState(
	input: SemanticInput,
	options?: BuildSemanticStateOptions,
): SemanticState {
	const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS;
	const content = input.content.slice(0, maxChars);

	return {
		content,
		contentLength: content.length,
		direction: input.direction,
		flags: input.flags === undefined ? [] : [...input.flags],
		role: input.role,
	};
}
