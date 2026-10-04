/**
 * User/group identity resolution (superseding the consumer-key model).
 *
 * Covers policy derivation (`identityPolicyFromDocument`), header extraction
 * (`identityFromRequest`, with the documented header names pinned), the
 * resolve matrix (`createIdentityResolver`) and the known-caller gate
 * (`requireKnownGroup`).
 */
import { describe, expect, it } from "bun:test";

import { createInMemoryAuditSink } from "#/control/audit.ts";
import {
	createIdentityResolver,
	type IdentityResolution,
	identityFromRequest,
	identityPolicyFromDocument,
	identityRejection,
	requireKnownGroup,
	USER_GROUP_ID_HEADER,
	USER_ID_HEADER,
} from "#/control/subjects.ts";

const resolver = createIdentityResolver({ knownGroups: ["hr", "manager"] });

function requestWithIdentity(userId: string | undefined, groupId: string | undefined): Request {
	const headers = new Headers();
	if (userId !== undefined) {
		headers.set(USER_ID_HEADER, userId);
	}
	if (groupId !== undefined) {
		headers.set(USER_GROUP_ID_HEADER, groupId);
	}
	return new Request("http://test.local/api/audit/export", { headers });
}

describe("identity resolution", () => {
	it("never falls back to a known group's configuration", () => {
		const result = resolver.resolve("alice", "manager-not-really");
		expect(result.ok).toBe(false);
	});
});

describe("createIdentityResolver matrix", () => {
	const matrix: {
		groupId: string | undefined;
		resolution: IdentityResolution;
		userId: string | undefined;
	}[] = [
		{
			groupId: "hr",
			resolution: { identity: { groupId: "hr", userId: "alice" }, kind: "known", ok: true },
			userId: "alice",
		},
		{
			groupId: "ghost-group",
			resolution: {
				groupId: "ghost-group",
				kind: "unknown-group",
				ok: false,
				reason: "user group not defined by policy: ghost-group",
				userId: "alice",
			},
			userId: "alice",
		},
		{
			groupId: "hr",
			resolution: {
				groupId: "hr",
				kind: "missing-identity",
				ok: false,
				reason: "no x-user-id presented",
				userId: undefined,
			},
			userId: undefined,
		},
		{
			groupId: undefined,
			resolution: {
				groupId: undefined,
				kind: "missing-identity",
				ok: false,
				reason: "no x-user-group-id presented",
				userId: "alice",
			},
			userId: "alice",
		},
		{
			groupId: "hr",
			resolution: {
				groupId: "hr",
				kind: "missing-identity",
				ok: false,
				reason: "no x-user-id presented",
				userId: "",
			},
			userId: "",
		},
		{
			groupId: "",
			resolution: {
				groupId: "",
				kind: "missing-identity",
				ok: false,
				reason: "no x-user-group-id presented",
				userId: "alice",
			},
			userId: "alice",
		},
		{
			groupId: undefined,
			resolution: {
				groupId: undefined,
				kind: "missing-identity",
				ok: false,
				reason: "no x-user-id presented",
				userId: undefined,
			},
			userId: undefined,
		},
	];

	for (const { groupId, resolution, userId } of matrix) {
		it(`resolve ${userId ?? "<missing>"} in ${groupId ?? "<missing>"} yields ${resolution.kind}`, () => {
			expect(resolver.resolve(userId, groupId)).toEqual(resolution);
		});
	}
});

describe("identityPolicyFromDocument", () => {
	it("maps every policy group to a known group", () => {
		const policy = identityPolicyFromDocument({
			hr: { profile: "strict" },
			manager: { profile: "standard" },
		});
		expect(policy.knownGroups).toEqual(["hr", "manager"]);
	});

	it("sorts known groups regardless of document order", () => {
		const groups = Object.fromEntries([
			["manager", { profile: "standard" }],
			["zeta", { profile: "permissive" }],
			["hr", { profile: "strict" }],
		]);
		const policy = identityPolicyFromDocument(groups);
		expect(policy.knownGroups).toEqual(["hr", "manager", "zeta"]);
	});

	it("defines no known groups for an empty document", () => {
		expect(identityPolicyFromDocument({}).knownGroups).toEqual([]);
	});
});

describe("identity headers", () => {
	it("pins the documented header names", () => {
		expect(USER_ID_HEADER).toBe("x-user-id");
		expect(USER_GROUP_ID_HEADER).toBe("x-user-group-id");
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

	it("treats missing headers as absent", () => {
		expect(identityFromRequest(new Request("http://test.local/"))).toEqual({
			groupId: undefined,
			userId: undefined,
		});
	});

	it("treats an empty group header as absent", () => {
		const request = new Request("http://test.local/", {
			headers: { "x-user-group-id": "" },
		});
		expect(identityFromRequest(request).groupId).toBeUndefined();
	});
});

describe("requireKnownGroup", () => {
	it("passes a known user in a known group with their identity", () => {
		const access = requireKnownGroup(requestWithIdentity("alice", "hr"), resolver);
		expect(access).toEqual({
			identity: { groupId: "hr", userId: "alice" },
			kind: "known",
			ok: true,
		});
	});

	it("rejects a missing identity without falling back", () => {
		const access = requireKnownGroup(requestWithIdentity(undefined, "hr"), resolver);
		expect(access.ok).toBe(false);
		if (!access.ok) {
			expect(access.reason).toContain("x-user-id");
		}
	});

	it("rejects an unknown group and names it", () => {
		const access = requireKnownGroup(requestWithIdentity("alice", "ghost-group"), resolver);
		expect(access.ok).toBe(false);
		if (!access.ok) {
			expect(access.kind).toBe("unknown-group");
			expect(access.reason).toContain("ghost-group");
		}
	});

	it("rejects a missing group without falling back to a known one", () => {
		const access = requireKnownGroup(requestWithIdentity("alice", undefined), resolver);
		expect(access.ok).toBe(false);
		if (!access.ok) {
			expect(access.reason).toContain("x-user-group-id");
		}
	});
});

describe("identityRejection audit attribution", () => {
	it("attributes an unknown-group denial to the presented user id", () => {
		const resolution = resolver.resolve("alice", "ghost-group");
		expect(resolution.ok).toBe(false);
		if (resolution.ok) {
			return;
		}
		const audit = createInMemoryAuditSink();
		const response = identityRejection(resolution, audit);
		expect(response.status).toBe(403);
		expect(audit.events).toHaveLength(1);
		const event = audit.events[0];
		expect(event?.consumerKey).toBe("alice");
		expect(event?.userId).toBe("alice");
		expect(event?.groupId).toBe("ghost-group");
		expect(event?.verdict).toBe("block");
		expect(event?.controlId).toBe("caller-identity");
	});

	it("falls back to (none) when no user id was presented", () => {
		const resolution = resolver.resolve(undefined, "hr");
		expect(resolution.ok).toBe(false);
		if (resolution.ok) {
			return;
		}
		const audit = createInMemoryAuditSink();
		const response = identityRejection(resolution, audit);
		expect(response.status).toBe(403);
		expect(audit.events).toHaveLength(1);
		expect(audit.events[0]?.consumerKey).toBe("(none)");
		expect(audit.events[0]?.userId).toBeUndefined();
	});

	it("attributes a missing-group denial to the presented user id", () => {
		const resolution = resolver.resolve("alice", undefined);
		expect(resolution.ok).toBe(false);
		if (resolution.ok) {
			return;
		}
		const audit = createInMemoryAuditSink();
		identityRejection(resolution, audit);
		expect(audit.events).toHaveLength(1);
		expect(audit.events[0]?.consumerKey).toBe("alice");
	});

	it("leaves the known-group ok path unaudited", () => {
		const resolution = resolver.resolve("alice", "hr");
		expect(resolution.ok).toBe(true);
		if (!resolution.ok) {
			return;
		}
		expect(resolution.identity).toEqual({ groupId: "hr", userId: "alice" });
	});
});
