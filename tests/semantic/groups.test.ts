import { describe, expect, it } from "bun:test";
import { SemanticConfigurationError } from "#/control/semantic/errors.ts";
import {
	checksForGroup,
	parseSemanticConfig,
	SEMANTIC_DEFAULTS,
	type SemanticConfig,
} from "#/control/semantic/index.ts";
import { byId } from "./helpers.ts";

const CHECK_IDS = [
	"data_exfiltration",
	"insider_trading",
	"jailbreak",
	"malicious_code",
	"privacy_violation",
	"prompt_injection",
];
const GROUP_IDS = ["hr", "manager", "software-developer"];

function configWith(overrides: Partial<SemanticConfig>): SemanticConfig {
	return { ...SEMANTIC_DEFAULTS, ...overrides };
}

describe("policy.jev.json groups", () => {
	it("defines the three user groups", () => {
		expect(Object.keys(SEMANTIC_DEFAULTS.groups).sort(byId)).toEqual(GROUP_IDS);
	});

	it("makes every check available to every group", () => {
		for (const groupId of GROUP_IDS) {
			expect([...(SEMANTIC_DEFAULTS.groups[groupId] ?? [])].sort()).toEqual(CHECK_IDS);
		}
	});

	it("returns the group's checks as full check definitions", () => {
		const checks = checksForGroup(SEMANTIC_DEFAULTS, "hr");
		expect(checks.map((check) => check.id).sort(byId)).toEqual(CHECK_IDS);
		for (const check of checks) {
			expect(check.type).toBe("boolean");
			expect(check.instructions.length).toBeGreaterThan(0);
		}
	});

	it("rejects an unknown group rather than falling back", () => {
		expect(() => checksForGroup(SEMANTIC_DEFAULTS, "ghost-group")).toThrow(
			SemanticConfigurationError,
		);
		expect(() => checksForGroup(SEMANTIC_DEFAULTS, "ghost-group")).toThrow(
			'unknown user group "ghost-group"',
		);
	});

	it("lets a group be restricted to a subset of checks", () => {
		const restricted = configWith({
			groups: { ...SEMANTIC_DEFAULTS.groups, hr: ["prompt_injection"] },
		});
		expect(checksForGroup(restricted, "hr").map((check) => check.id)).toEqual(["prompt_injection"]);
		// The other groups are untouched.
		expect(checksForGroup(restricted, "manager")).toHaveLength(CHECK_IDS.length);
	});
});

describe("group mapping validation", () => {
	it("rejects a group listing an undefined check", () => {
		expect(() =>
			parseSemanticConfig({
				...SEMANTIC_DEFAULTS,
				groups: { ...SEMANTIC_DEFAULTS.groups, hr: ["no_such_check"] },
			}),
		).toThrow('group "hr" lists unknown check "no_such_check"');
	});

	it("rejects a group listing the same check twice", () => {
		expect(() =>
			parseSemanticConfig({
				...SEMANTIC_DEFAULTS,
				groups: {
					...SEMANTIC_DEFAULTS.groups,
					hr: ["prompt_injection", "prompt_injection"],
				},
			}),
		).toThrow('group "hr" lists check "prompt_injection" twice');
	});

	it("rejects a document with no groups mapping", () => {
		const { groups: _groups, ...withoutGroups } = SEMANTIC_DEFAULTS;
		expect(() => parseSemanticConfig(withoutGroups)).toThrow(SemanticConfigurationError);
	});
});
