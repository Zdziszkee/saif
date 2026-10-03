import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Unit tier: hermetic, credential-free, no network. Integration tests that
 * exercise real Jev live in `tests/integration/` and run via `test:integration`.
 *
 * `#/*` maps to `src/*` via the package.json `imports` field for the app; the
 * alias makes the same mapping work under vitest.
 */
export default defineConfig({
	resolve: {
		alias: {
			"#": fileURLToPath(new URL("./src", import.meta.url)),
		},
	},
	test: {
		environment: "node",
		include: ["tests/**/*.test.ts"],
	},
});
