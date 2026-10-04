import { describe, expect, it } from "bun:test";

import { matchesPerson, personLabel, roleLabel } from "#/components/dashboard/persons.ts";

describe("personLabel", () => {
	const cases: readonly { expected: string; userId: string }[] = [
		{ expected: "alice", userId: "alice" },
		{ expected: "", userId: "" },
		{ expected: "alice@example.com", userId: "alice@example.com" },
		{ expected: "Zoë-Müller", userId: "Zoë-Müller" },
		{ expected: "  spaced  ", userId: "  spaced  " },
	];
	for (const { expected, userId } of cases) {
		it(`returns the userId unchanged for ${JSON.stringify(userId)}`, () => {
			// Arrange: raw userId, no directory.
			// Act:
			const actual = personLabel(userId);
			// Assert: identity mapping.
			expect(actual).toBe(expected);
		});
	}
});

describe("roleLabel", () => {
	const cases: readonly { expected: string; groupId: string }[] = [
		{ expected: "Software developer", groupId: "software-developer" },
		{ expected: "Software developer", groupId: "software_developer" },
		{ expected: "On call hero", groupId: "on-call_hero" },
		{ expected: "Hr", groupId: "hr" },
		{ expected: "Manager", groupId: "manager" },
		{ expected: "A", groupId: "a" },
		{ expected: "Admin", groupId: "-admin-" },
		{ expected: "On call", groupId: "on--call" },
		{ expected: "SOFTWARE DEVELOPER", groupId: "SOFTWARE-DEVELOPER" },
		{ expected: "Software Developer", groupId: "Software-Developer" },
		{ expected: "(none)", groupId: "" },
		{ expected: "(none)", groupId: "   " },
		{ expected: "(none)", groupId: "---___" },
		{ expected: "Manager", groupId: "  manager  " },
	];
	for (const { expected, groupId } of cases) {
		it(`maps ${JSON.stringify(groupId)} to ${JSON.stringify(expected)}`, () => {
			// Arrange: raw policy groupId.
			// Act:
			const actual = roleLabel(groupId);
			// Assert: humanized label.
			expect(actual).toBe(expected);
		});
	}
});

describe("matchesPerson", () => {
	const cases: readonly { expected: boolean; query: string | undefined; userId: string }[] = [
		{ expected: true, query: undefined, userId: "alice" },
		{ expected: true, query: "", userId: "alice" },
		{ expected: true, query: "   ", userId: "alice" },
		{ expected: true, query: "\t\n ", userId: "alice" },
		{ expected: true, query: "alice", userId: "alice" },
		{ expected: true, query: "ALICE", userId: "alice" },
		{ expected: true, query: "AlIcE", userId: "aLiCe" },
		{ expected: true, query: "lic", userId: "alice" },
		{ expected: true, query: "LIC", userId: "alice" },
		{ expected: true, query: "  alice  ", userId: "alice" },
		{ expected: true, query: "müller", userId: "Zoë-Müller" },
		{ expected: true, query: "MÜLLER", userId: "zoë-müller" },
		{ expected: true, query: "zoë", userId: "Zoë-Müller" },
		{ expected: false, query: "bob", userId: "alice" },
		{ expected: false, query: "alice!", userId: "alice" },
		{ expected: false, query: "alices", userId: "alice" },
		{ expected: false, query: " müller2 ", userId: "Zoë-Müller" },
	];
	for (const { expected, query, userId } of cases) {
		it(`returns ${String(expected)} for userId ${JSON.stringify(userId)} query ${JSON.stringify(query)}`, () => {
			// Arrange: userId plus optional search query.
			// Act:
			const actual = matchesPerson(userId, query);
			// Assert: pass-through vs. case-insensitive substring.
			expect(actual).toBe(expected);
		});
	}
});
