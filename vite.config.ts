import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

const config = defineConfig({
	plugins: [
		devtools(),
		nitro({ preset: "bun", rollupConfig: { external: [/^@sentry\//] } }),
		tailwindcss(),
		tanstackStart(),
		viteReact(),
	],
	resolve: { tsconfigPaths: true },
	ssr: {
		// `bun:sqlite` is a Bun-runtime builtin, not a package Vite can
		// resolve/transform. Leave it for the runtime to load natively;
		// otherwise the SSR loader fails with an unknown-protocol error.
		external: ["bun:sqlite"],
	},
});

export default config;
