import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Live suite: exercises the real TypeSafe/Jev path. Requires TYPESAFE_API_KEY.
 * Run with `bun run test:live`; the hermetic suite never loads these tests.
 */
export default defineConfig({
	resolve: {
		alias: {
			"#": fileURLToPath(new URL("./src", import.meta.url)),
		},
	},
	test: {
		environment: "node",
		include: ["tests/**/*.live.test.ts"],
	},
});
