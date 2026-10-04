/**
 * Caller identity across seams (interaction-gateway requirement).
 *
 * Every seam accepts a user id and a user group id through defined request
 * headers. The user id identifies the individual and is the unit of usage
 * limiting and per-user reporting; the group id identifies the policy subject —
 * it selects the strictness profile and the semantic checks that apply — and is
 * the unit of group-level reporting.
 *
 * A missing identity, or a group the policy does not define, is a rejection.
 * Callers never fall back to another caller's configuration: an unknown group
 * silently inheriting someone else's guardrails would be a security hole.
 */

export const USER_ID_HEADER = "x-user-id";
export const USER_GROUP_ID_HEADER = "x-user-group-id";

/** The caller as presented on a request. */
export interface CallerIdentity {
	/** Policy subject: selects the profile and the applicable control set. */
	groupId: string;
	/** The individual: usage limits and per-user reporting. */
	userId: string;
}

export type IdentityResolution =
	| { identity: CallerIdentity; kind: "known"; ok: true }
	| {
			groupId: string | undefined;
			kind: "missing-identity" | "unknown-group";
			ok: false;
			reason: string;
			userId: string | undefined;
	  };

export interface IdentityPolicy {
	/** Group ids the policy defines. Anything else is rejected. */
	knownGroups: readonly string[];
}

export interface IdentityResolver {
	resolve(userId: string | undefined, groupId: string | undefined): IdentityResolution;
}

export function createIdentityResolver(policy: IdentityPolicy): IdentityResolver {
	const known = new Set(policy.knownGroups);
	return {
		resolve(userId, groupId) {
			if (userId === undefined || userId.length === 0) {
				return {
					groupId,
					kind: "missing-identity",
					ok: false,
					reason: `no ${USER_ID_HEADER} presented`,
					userId,
				};
			}
			if (groupId === undefined || groupId.length === 0) {
				return {
					groupId,
					kind: "missing-identity",
					ok: false,
					reason: `no ${USER_GROUP_ID_HEADER} presented`,
					userId,
				};
			}
			if (!known.has(groupId)) {
				return {
					groupId,
					kind: "unknown-group",
					ok: false,
					reason: `user group not defined by policy: ${groupId}`,
					userId,
				};
			}
			return {
				identity: { groupId, userId },
				kind: "known",
				ok: true,
			};
		},
	};
}

/** Read both identity headers from a request. Absent headers become `undefined`. */
export function identityFromRequest(request: Request): {
	groupId: string | undefined;
	userId: string | undefined;
} {
	const userId = request.headers.get(USER_ID_HEADER);
	const groupId = request.headers.get(USER_GROUP_ID_HEADER);
	return {
		groupId: groupId === null || groupId.length === 0 ? undefined : groupId,
		userId: userId === null || userId.length === 0 ? undefined : userId,
	};
}
