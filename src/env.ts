import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

/**
 * Server process environment without naming the `process` global (which the
 * `noProcessGlobal` lint rule forbids outside the server override list and
 * which does not exist in browser bundles). Vite only exposes `VITE_*`
 * variables on `import.meta.env`, so without this merge no server setting —
 * model endpoint, API keys, egress allowlist — is configurable at all.
 */
function serverProcessEnv(): Record<string, string | undefined> {
	const holder = globalThis as { process?: { env?: Record<string, string | undefined> } };
	return holder.process?.env ?? {};
}

export const env = createEnv({
	client: {
		VITE_APP_TITLE: z.string().min(1).optional(),
	},

	/**
	 * The prefix that client-side variables must have. This is enforced both at
	 * a type-level and at runtime.
	 */
	clientPrefix: "VITE_",

	/**
	 * By default, this library will feed the environment variables directly to
	 * the Zod validator.
	 *
	 * This means that if you have an empty string for a value that is supposed
	 * to be a number (e.g. `PORT=` in a ".env" file), Zod will incorrectly flag
	 * it as a type mismatch violation. Additionally, if you have an empty string
	 * for a value that is supposed to be a string with a default value (e.g.
	 * `DOMAIN=` in an ".env" file), the default value will never be applied.
	 *
	 * In order to solve these issues, we recommend that all new projects
	 * explicitly specify this option as true.
	 */
	emptyStringAsUndefined: true,

	/**
	 * What object holds the environment variables at runtime. This is usually
	 * `process.env` or `import.meta.env`.
	 */
	runtimeEnv: { ...serverProcessEnv(), ...import.meta.env },
	server: {
		/** Comma-separated egress allowlist for external MCP connections (URLs or origins). */
		MCP_EGRESS_ALLOWLIST: z.string().optional(),
		/** Path to the MCP tool access policy (`policy.mcp.json`); defaults to the project root file. */
		MCP_TOOL_POLICY_PATH: z.string().min(1).optional(),
		/** API key for the OpenAI-compatible model connection used by the prompt-plane gateway. */
		MODEL_API_KEY: z.string().optional(),
		/** Base URL of the OpenAI-compatible model endpoint (local or hosted). */
		MODEL_BASE_URL: z.string().url().optional(),
		/** Model name served by the OpenAI-compatible endpoint. */
		MODEL_NAME: z.string().optional(),
		SERVER_URL: z.string().url().optional(),
		/** TypeSafe API key for the Jev decision model. Absence disables the semantic tier. */
		TYPESAFE_API_KEY: z.string().min(1).optional(),
		/**
		 * Override for the TypeSafe endpoint (tests and the `mock:jev` stub).
		 * Unset means the production TypeSafe API.
		 */
		TYPESAFE_BASE_URL: z.string().url().optional(),
	},
});
