/**
 * Narrowing guard for string-literal membership.
 *
 * Several modules tested `typeof v === "string"` plus a widened
 * `(LIST as readonly string[]).includes(v)` cast. A predicate keeps the
 * literal types (no widening cast) and reads as a question, not a cast.
 */

/** True when `value` is one of the listed string literals. */
export function isOneOf<T extends string>(value: unknown, list: readonly T[]): value is T {
	return typeof value === "string" && list.some((entry) => entry === value);
}
