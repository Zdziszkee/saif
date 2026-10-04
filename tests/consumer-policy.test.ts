/**
 * User/group identity resolution (superseding the consumer-key model).
 */
import { describe, expect, it } from "bun:test";

import {
	createIdentityResolver,
	identityFromRequest,
	identityPolicyFromDocument,
} from "#/control/subjects.ts";

const resolver = createIdentityResolver({ knownGroups: ["hr", "manager"] });

describe("identity resolution", () => {
	it("accepts a known user in a known group", () => {
		const result = resolver.resolve("alice", "hr");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.identity).toEqual({ groupId: "hr", userId: "alice" });
		}
	});

	it("rejects an unknown group and names it", () => {
		const result = resolver.resolve("alice", "ghost-group");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.kind).toBe("unknown-group");
			expect(result.reason).toContain("ghost-group");
		}
	});

	it("rejects a missing user id", () => {
		const result = resolver.resolve(undefined, "hr");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.kind).toBe("missing-identity");
		}
	});

	it("rejects a missing group id", () => {
		const result = resolver.resolve("alice", undefined);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain("x-user-group-id");
		}
	});

	it("never falls back to a known group's configuration", () => {
		const result = resolver.resolve("alice", "manager-not-really");
		expect(result.ok).toBe(false);
	});
});

describe("identityPolicyFromDocument", () => {
	it("maps every policy group to a known group", () => {
		const policy = identityPolicyFromDocument({
			hr: { profile: "strict" },
			manager: { profile: "standard" },
		});
		expect(policy.knownGroups).toEqual(["hr", "manager"]);
	});
});

describe("identityFromRequest", () => {
	it("reads both identity headers", () => {
		const request = new Request("http://test.local/", {
			headers: { "x-user-group-id": "hr", "x-user-id": "alice" },
		});
		expect(identityFromRequest(request)).toEqual({ groupId: "hr", userId: "alice" });
	});

	it("treats an empty header as absent", () => {
		const request = new Request("http://test.local/", {
			headers: { "x-user-id": "" },
		});
		expect(identityFromRequest(request).userId).toBeUndefined();
	});
});
