export const ACTIONS = ["allow", "block", "flag", "redact"] as const;
export const BUILTIN_KEYS = [
	"encodingRescan",
	"entropyScan",
	"genericCredentials",
	"pii",
	"providerSecrets",
] as const;
export const DIRECTIONS = ["inbound", "outbound"] as const;
export const PROFILE_NAMES = ["permissive", "standard", "strict"] as const;
export const VERDICTS = ["allow", "block", "escalate", "redact"] as const;

export const TEXT_INPUT_CLASS =
	"w-full rounded-md border border-input bg-transparent px-2 py-1 text-sm shadow-xs outline-none focus-visible:border-ring";

export type Action = (typeof ACTIONS)[number];
export type BuiltinKey = (typeof BUILTIN_KEYS)[number];
export type Direction = (typeof DIRECTIONS)[number];
export type ProfileName = (typeof PROFILE_NAMES)[number];
export type Verdict = (typeof VERDICTS)[number];

function isOneOf<Options extends string>(
	options: readonly Options[],
	value: string,
): value is Options {
	return (options as readonly string[]).includes(value);
}

export function isAction(value: string): value is Action {
	return isOneOf(ACTIONS, value);
}

export function isProfileName(value: string): value is ProfileName {
	return isOneOf(PROFILE_NAMES, value);
}

export function isVerdict(value: string): value is Verdict {
	return isOneOf(VERDICTS, value);
}
