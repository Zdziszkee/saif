/**
 * Regex match scanner with the `matchAll` undefined-guard in one place.
 *
 * Detector, rule, signature, and name-index loops each wrote
 * `for (const match of text.matchAll(regex))` plus the
 * `value === undefined || start === undefined` skip. A successful global
 * match always defines both, but `noUncheckedIndexedAccess` forces the
 * guard; keeping it here preserves behavior while removing the repetition.
 */

/** Visit every match of `regex` in `text` with its value and start offset. */
export function scanMatches(
	text: string,
	regex: RegExp,
	visit: (value: string, start: number) => void,
): void {
	for (const match of text.matchAll(regex)) {
		const value = match[0];
		const start = match.index;
		if (value === undefined || start === undefined) {
			continue;
		}
		visit(value, start);
	}
}
