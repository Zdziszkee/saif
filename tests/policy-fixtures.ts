import type { PolicyInput, Profile } from "#/control/policy/schema.ts";

export function makeProfile(thresholds: {
	block: number;
	escalate: number;
	redact: number;
}): Profile {
	const direction = { ...thresholds };
	return {
		enabledControls: { detection: true, semantic: true, signatures: true },
		thresholds: {
			detection: { inbound: { ...direction }, outbound: { ...direction } },
			semantic: { inbound: { ...direction }, outbound: { ...direction } },
			signatures: { inbound: { ...direction }, outbound: { ...direction } },
		},
	};
}

export const basePolicy: PolicyInput = {
	controls: {
		allowlist: {
			models: [{ endpoint: "https://api.example.com/v1", name: "primary" }],
		},
		budget: {
			overBudgetVerdict: "block",
			rules: [{ key: "alice", modelScope: "*", period: "day", tokens: 100_000 }],
		},
		detection: {
			builtins: {
				encodingRescan: true,
				entropyScan: true,
				genericCredentials: true,
				pii: true,
				providerSecrets: true,
			},
			defaultActions: {
				custom: "redact",
				pii: "redact",
				secret: "block",
				suspect: "flag",
			},
			rules: [
				{
					action: "flag",
					directions: ["outbound"],
					id: "internal-codename",
					kind: "custom",
					pattern: "\\bCONFIDENTIAL\\b",
				},
			],
		},
		enabled: true,
		redaction: { enabled: true },
		shape: { maxContentBytes: 65_536 },
		signatures: {
			enabled: true,
			perSignatureActions: { "atlas-sig-001": "redact" },
			severityActions: {
				critical: "block",
				high: "block",
				low: "flag",
				medium: "redact",
			},
			suspect: { action: "escalate", threshold: 0.8 },
		},
	},
	defaults: { failureVerdict: "escalate" },
	groups: {
		hr: { profile: "standard" },
		manager: { profile: "standard" },
	},
	profiles: {
		permissive: makeProfile({ block: 0.95, escalate: 0.3, redact: 0.7 }),
		standard: makeProfile({ block: 0.85, escalate: 0.4, redact: 0.6 }),
		strict: makeProfile({ block: 0.7, escalate: 0.5, redact: 0.5 }),
	},
	version: "1",
};

export function cloneBase(): PolicyInput {
	return structuredClone(basePolicy);
}

export function firstOf<T>(items: readonly T[]): T {
	const item = items[0];
	if (item === undefined) {
		throw new Error("fixture is empty");
	}
	return item;
}
