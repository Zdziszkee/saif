import { describe, expect, it } from "bun:test";

import {
	DEFAULT_ESCALATION_LIMIT,
	formatVersions,
	selectEscalations,
	summarizeControlsInForce,
	UNKNOWN_PROFILE,
	UNKNOWN_VERSION,
} from "#/components/dashboard-meta.ts";
import { type AuditEvent, auditEvent } from "#/control/audit.ts";
import { type Policy, type PolicyInput, parsePolicy } from "#/control/policy/schema.ts";
import { cloneBase } from "./policy-fixtures.ts";

function mustParse(input: PolicyInput): Policy {
	const result = parsePolicy(input);
	if (!result.success) {
		throw new Error("fixture policy failed validation");
	}
	return result.policy;
}

function stamp(day: number): string {
	return `2026-04-${String(day).padStart(2, "0")}T00:00:00.000Z`;
}

function escalation(
	interactionId: string,
	consumerKey: string,
	day: number,
	controlId = "deterministic",
): AuditEvent {
	return {
		...auditEvent("interaction", {
			consumerKey,
			controlId,
			interactionId,
			subject: consumerKey,
			verdict: "escalate",
		}),
		timestamp: stamp(day),
	};
}

function decision(
	interactionId: string,
	consumerKey: string,
	day: number,
	verdict: "allow" | "block",
): AuditEvent {
	return {
		...auditEvent("interaction", {
			consumerKey,
			controlId: "deterministic",
			interactionId,
			subject: consumerKey,
			verdict,
		}),
		timestamp: stamp(day),
	};
}

function note(interactionId: string, consumerKey: string, day: number): AuditEvent {
	return {
		...auditEvent("interaction", {
			consumerKey,
			interactionId,
			subject: consumerKey,
		}),
		timestamp: stamp(day),
	};
}

function admission(interactionId: string, consumerKey: string, day: number): AuditEvent {
	return {
		...auditEvent("registration", {
			consumerKey,
			interactionId,
			subject: consumerKey,
			verdict: "escalate",
		}),
		timestamp: stamp(day),
	};
}

function failure(interactionId: string, consumerKey: string, day: number): AuditEvent {
	return {
		...auditEvent("failure", {
			consumerKey,
			interactionId,
			subject: consumerKey,
			verdict: "escalate",
		}),
		timestamp: stamp(day),
	};
}

// Oldest first so newest-first ordering is pinned by insertion order.
const MIXED: readonly AuditEvent[] = [
	decision("alice-allow", "alice", 1, "allow"),
	escalation("alice-escalate-1", "alice", 2),
	escalation("bob-escalate", "bob", 3, "signatures"),
	escalation("alice-escalate-2", "alice", 4, "semantic"),
	decision("alice-block", "alice", 5, "block"),
	note("alice-note", "alice", 6),
	admission("bob-admission", "bob", 7),
	failure("alice-failure", "alice", 8),
];

describe("selectEscalations", () => {
	it("keeps only escalate-verdict decisions, newest first", () => {
		const queue = selectEscalations(MIXED);
		expect(queue.map((event) => event.interactionId)).toEqual([
			"alice-escalate-2",
			"bob-escalate",
			"alice-escalate-1",
		]);
	});

	it("excludes verdict-less notes and non-interaction kinds", () => {
		const ids = selectEscalations(MIXED).map((event) => event.interactionId);
		expect(ids).not.toContain("alice-note");
		expect(ids).not.toContain("bob-admission");
		expect(ids).not.toContain("alice-failure");
	});

	it("caps the queue at the requested limit", () => {
		expect(selectEscalations(MIXED, 2).map((event) => event.interactionId)).toEqual([
			"alice-escalate-2",
			"bob-escalate",
		]);
	});

	it("covers the whole queue under the default limit", () => {
		expect(selectEscalations(MIXED, DEFAULT_ESCALATION_LIMIT)).toHaveLength(3);
	});

	it("scopes the queue to one consumer key", () => {
		const alice = selectEscalations(MIXED, DEFAULT_ESCALATION_LIMIT, "alice");
		expect(alice.map((event) => event.interactionId)).toEqual([
			"alice-escalate-2",
			"alice-escalate-1",
		]);
		expect(selectEscalations(MIXED, DEFAULT_ESCALATION_LIMIT, "bob")).toHaveLength(1);
	});

	it("returns empty for an unknown consumer", () => {
		expect(selectEscalations(MIXED, DEFAULT_ESCALATION_LIMIT, "carol")).toEqual([]);
	});

	it("applies the cap after scoping to one consumer", () => {
		const alice = selectEscalations(MIXED, 1, "alice");
		expect(alice.map((event) => event.interactionId)).toEqual(["alice-escalate-2"]);
	});

	it("returns empty for missing input", () => {
		expect(selectEscalations(undefined)).toEqual([]);
	});

	it("returns empty for non-positive or non-finite limits", () => {
		expect(selectEscalations(MIXED, 0)).toEqual([]);
		expect(selectEscalations(MIXED, -5)).toEqual([]);
		expect(selectEscalations(MIXED, Number.NaN)).toEqual([]);
		expect(selectEscalations(MIXED, Number.POSITIVE_INFINITY)).toEqual([]);
	});
});

describe("formatVersions", () => {
	it("reads unknown when versions are missing", () => {
		expect(formatVersions()).toEqual({ feed: UNKNOWN_VERSION, policy: UNKNOWN_VERSION });
		expect(formatVersions(undefined, undefined).policy).toBe("unknown");
	});

	it("reads unknown for blank versions", () => {
		expect(formatVersions("", "   ")).toEqual({
			feed: UNKNOWN_VERSION,
			policy: UNKNOWN_VERSION,
		});
	});

	it("trims surrounding whitespace", () => {
		expect(formatVersions("  abc123  ", undefined).policy).toBe("abc123");
	});

	it("shortens full SHA-256 stamps to 12 hex chars", () => {
		const sha = "ab".repeat(32);
		const versions = formatVersions(sha, sha);
		expect(sha).toHaveLength(64);
		expect(versions.policy).toBe("abababababab");
		expect(versions.feed).toBe("abababababab");
	});

	it("passes short labels like the unavailable feed state through", () => {
		expect(formatVersions("v3", "unavailable")).toEqual({ feed: "unavailable", policy: "v3" });
	});

	it("leaves non-lowercase 64-char stamps alone", () => {
		const upper = "AB".repeat(32);
		expect(formatVersions(upper, upper)).toEqual({ feed: upper, policy: upper });
	});
});

describe("summarizeControlsInForce", () => {
	it("reports unknown with no controls when no policy is loaded", () => {
		expect(summarizeControlsInForce(undefined)).toEqual({ enabled: [], profile: UNKNOWN_PROFILE });
	});

	it("lists the default profile's controls in pipeline order", () => {
		const summary = summarizeControlsInForce(mustParse(cloneBase()));
		expect(summary.profile).toBe("standard");
		expect(summary.enabled).toEqual(["allowlist", "signatures", "detection", "semantic"]);
	});

	it("omits disabled flags but keeps the always-on allowlist", () => {
		const input = cloneBase();
		input.profiles.standard.enabledControls.semantic = false;
		input.profiles.standard.enabledControls.signatures = false;
		const summary = summarizeControlsInForce(mustParse(input));
		expect(summary).toEqual({ enabled: ["allowlist", "detection"], profile: "standard" });
	});

	it("follows the defaults profile, not a hardcoded one", () => {
		const input = cloneBase();
		input.defaults.profile = "strict";
		input.profiles.strict.enabledControls.detection = false;
		const summary = summarizeControlsInForce(mustParse(input));
		expect(summary).toEqual({
			enabled: ["allowlist", "signatures", "semantic"],
			profile: "strict",
		});
	});

	it("keeps the allowlist when every flag is off", () => {
		const input = cloneBase();
		input.profiles.standard.enabledControls.detection = false;
		input.profiles.standard.enabledControls.semantic = false;
		input.profiles.standard.enabledControls.signatures = false;
		const summary = summarizeControlsInForce(mustParse(input));
		expect(summary).toEqual({ enabled: ["allowlist"], profile: "standard" });
	});
});
