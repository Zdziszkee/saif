/**
 * Multi-consumer connections (interaction-gateway requirement).
 *
 * Every seam accepts a consumer key through a defined request header
 * (`x-consumer-key`). The key identifies the policy subject the caller acts
 * as, and each consumer's traffic is governed in isolation. A missing or
 * unknown key follows the policy's configured default-subject behavior —
 * a defined default subject or rejection — and never silently inherits
 * another consumer's configuration.
 */

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
	const key = request.headers.get(CONSUMER_KEY_HEADER);
	return key === null || key.length === 0 ? undefined : key;
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
