/**
 * Lenient JSON parsing with explicit fallbacks.
 *
 * Tool-argument and tool-result paths each retried `JSON.parse` in a
 * try/catch with a hardcoded fallback (`{}` for arguments, the original
 * text for results). Named helpers make the intended fallback visible at
 * the call site instead of burying it in a catch block.
 */

/** Parse `text` as JSON, returning an empty object when it is not JSON. */
export function parseJsonOrEmpty(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return {};
	}
}

/** Parse `text` as JSON, returning the original text when it is not JSON. */
export function parseJsonOrForward(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}
