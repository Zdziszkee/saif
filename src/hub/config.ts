/**
 * Hub governance configuration seam.
 *
 * The policy-engine spec module owns the policy document; until it lands, the
 * hub receives its governance knobs (tool-call enforcement mode, agentic-loop
 * budgets, egress allowlist for external MCP connections) through this
 * zod-validated configuration object with conservative defaults.
 */

import { z } from "zod";

const DEFAULT_MAX_COMPUTE_MS = 30_000;
const DEFAULT_MAX_TOOL_ROUNDS = 5;

export const hubConfigSchema = z.strictObject({
	/** Endpoints (URLs or origins, `*` wildcards allowed) external MCP servers may connect to. */
	egressAllowlist: z.array(z.string().min(1)).default([]),
	/**
	 * Caller identity handling at every seam. The user group is the policy
	 * subject: it selects the profile and the applicable control set. Unknown
	 * groups are rejected, never defaulted to another group's configuration.
	 */
	identity: z
		.strictObject({
			/** User group ids the policy defines. Anything else is rejected. */
			knownGroups: z.array(z.string().min(1)).default([]),
		})
		.default({ knownGroups: [] }),
	loop: z
		.strictObject({
			/** Compute-time budget for one governed agentic loop, in milliseconds. */
			maxComputeMs: z.number().int().positive().default(DEFAULT_MAX_COMPUTE_MS),
			/** Request-count budget: model requests per governed agentic loop. */
			maxToolRounds: z.number().int().positive().default(DEFAULT_MAX_TOOL_ROUNDS),
		})
		.default({ maxComputeMs: DEFAULT_MAX_COMPUTE_MS, maxToolRounds: DEFAULT_MAX_TOOL_ROUNDS }),
	/**
	 * How a blocked tool call is enforced:
	 * `tool` refuses the call with a defined tool error and the turn continues;
	 * `turn` rejects the whole turn with the defined rejection response.
	 */
	toolEnforcement: z.enum(["tool", "turn"]).default("tool"),
});

export type HubConfig = z.output<typeof hubConfigSchema>;
export type ToolEnforcement = HubConfig["toolEnforcement"];

export function createHubConfig(input: unknown = {}): HubConfig {
	return hubConfigSchema.parse(input);
}

/**
 * Egress allowlist check for external MCP connection endpoints. Entries are
 * matched as exact URLs, origins, or `*`-wildcard prefixes.
 */
export function isEgressAllowed(endpoint: string, allowlist: readonly string[]): boolean {
	let origin: string;
	let href: string;
	try {
		const url = new URL(endpoint);
		origin = url.origin;
		href = url.href;
	} catch {
		return false;
	}
	return allowlist.some((entry) => {
		if (entry.includes("*")) {
			const pattern = entry.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
			return new RegExp(`^${pattern}$`).test(href) || new RegExp(`^${pattern}$`).test(origin);
		}
		if (entry === href || entry === origin) {
			return true;
		}
		try {
			return new URL(entry).href === href;
		} catch {
			return false;
		}
	});
}
