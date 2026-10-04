/**
 * Per-module interaction-id sequences.
 *
 * Chat and shape seams each kept a `Date.now()` + counter id factory with
 * only the prefix differing. A factory preserves each seam's independent
 * counter while keeping the `${prefix}_${millis}_${sequence}` shape in one
 * place. Uniqueness still relies on the prefix per seam, as before.
 */

/** Create a `<prefix>_<millis>_<sequence>` id factory with its own counter. */
export function createIdSequence(prefix: string): () => string {
	let sequence = 0;
	return () => {
		sequence += 1;
		return `${prefix}_${Date.now()}_${sequence}`;
	};
}
