/**
 * Caller identity across seams (interaction-gateway requirement).
 *
 * Two complementary mechanisms share this module. Consumer keys travel in
 * `x-consumer-key`: the key identifies the policy subject the caller acts
 * as, with default-subject or rejection behavior for missing and unknown
 * keys. User identity travels in `x-user-id` / `x-user-group-id`: the user
 * id identifies the individual and is the unit of usage limiting and
 * per-user reporting; the group id identifies the policy subject — it
 * selects the strictness profile and the semantic checks that apply — and
 * is the unit of group-level reporting.
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

export const CONSUMER_KEY_HEADER = "x-consumer-key";

export interface ConsumerPolicy {
	/** Policy subject used by the default-subject behavior. */
	defaultSubject: string;
	/** Consumer keys the policy defines; each maps to a policy subject of the same name. */
	knownKeys: readonly string[];
	/** Behavior for missing or unknown consumer keys. */
	unknownKey: "default-subject" | "reject";
}

export type SubjectResolution =
	| { key: string | undefined; kind: "known"; ok: true; subject: string }
	| { key: string | undefined; kind: "default-subject"; ok: true; subject: string }
	| { key: string | undefined; kind: "missing" | "unknown"; ok: false; reason: string };

export interface ConsumerResolver {
	resolve(key: string | undefined): SubjectResolution;
}

export function createConsumerResolver(policy: ConsumerPolicy): ConsumerResolver {
	const known = new Set(policy.knownKeys);
	return {
		resolve(key) {
			if (key !== undefined && known.has(key)) {
				return { key, kind: "known", ok: true, subject: key };
			}
			if (policy.unknownKey === "reject") {
				return {
					key,
					kind: key === undefined ? "missing" : "unknown",
					ok: false,
					reason:
						key === undefined
							? "no consumer key presented"
							: `consumer key not defined by policy: ${key}`,
				};
			}
			return { key, kind: "default-subject", ok: true, subject: policy.defaultSubject };
		},
	};
}

export function consumerKeyFromRequest(request: Request): string | undefined {
	// `||` is deliberate: `headers.get` returns `null` when the header is absent
	// and `""` when it is present but empty, and both mean "no key presented".
	// `??` would pass `""` through.
	return request.headers.get(CONSUMER_KEY_HEADER) || undefined;
}

/**
 * Derive the consumer-key policy from the policy document's `consumers` map:
 * every policy-defined consumer key identifies a policy subject of the same
 * name. Unknown and missing keys keep the configured default-subject or
 * rejection behavior and never inherit a known subject's configuration.
 */
export function consumerPolicyFromDocument(
	consumers: Readonly<Record<string, unknown>>,
	options: Pick<ConsumerPolicy, "defaultSubject" | "unknownKey"> = {
		defaultSubject: "default",
		unknownKey: "default-subject",
	},
): ConsumerPolicy {
	return {
		defaultSubject: options.defaultSubject,
		knownKeys: Object.keys(consumers).sort(),
		unknownKey: options.unknownKey,
	};
}

/**
 * Gate for machine endpoints that must not inherit the guard seam's
 * default-subject behavior (e.g. the audit export, which would otherwise
 * hand bulk audit data — including matched user content — to any keyless
 * caller). Only a key the policy defines passes; anything else is rejected
 * with a reason suitable for a 403 body.
 */
export function requireKnownConsumer(
	request: Request,
	consumers: ConsumerResolver,
): { ok: true; subject: string } | { ok: false; reason: string } {
	const resolution = consumers.resolve(consumerKeyFromRequest(request));
	if (resolution.ok && resolution.kind === "known") {
		return { ok: true, subject: resolution.subject };
	}
	return {
		ok: false,
		reason: resolution.ok ? "this endpoint requires a known consumer key" : resolution.reason,
	};
}
