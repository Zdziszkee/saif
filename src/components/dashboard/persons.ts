/**
 * Person/role label helpers for the dashboard person view.
 *
 * A person IS the raw `userId` string: no directory exists, so `personLabel`
 * is the single place where a future directory lookup plugs in. A role IS the
 * raw policy `groupId` string (`hr`, `manager`, `software-developer`).
 *
 * Pure functions with zero imports from dashboard/control layers.
 */

const NONE_ROLE_LABEL = "(none)";
const ROLE_SEPARATOR_PATTERN = /[-_]+/;

/**
 * Display label for a person. Today this is the `userId` unchanged; plug a
 * future directory lookup in here when one exists.
 */
export function personLabel(userId: string): string {
	return userId;
}

/** Display label for a role (`groupId`): separators become spaces, first letter uppercased. */
export function roleLabel(groupId: string): string {
	const trimmed = groupId.trim();
	if (trimmed.length === 0) {
		return NONE_ROLE_LABEL;
	}
	const words = trimmed.split(ROLE_SEPARATOR_PATTERN).filter((word) => word.length > 0);
	if (words.length === 0) {
		return NONE_ROLE_LABEL;
	}
	const joined = words.join(" ");
	return `${joined.charAt(0).toUpperCase()}${joined.slice(1)}`;
}

/** True when no query is given or the `userId` contains it (case-insensitive). */
export function matchesPerson(userId: string, query: string | undefined): boolean {
	if (query === undefined) {
		return true;
	}
	const trimmed = query.trim();
	if (trimmed.length === 0) {
		return true;
	}
	return userId.toLowerCase().includes(trimmed.toLowerCase());
}
