import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"#": fileURLToPath(new URL("./src", import.meta.url)),
		},
	},
	test: {
		environment: "node",
		// Live tests hit the real Jev API; run them with `bun run test:live`.
		exclude: ["**/node_modules/**", "tests/**/*.live.test.ts"],
		include: ["tests/**/*.test.ts"],
	},
});
