/**
 * Pre-hydration theme bootstrap for the Saif UI.
 *
 * Mirrors `src/lib/theme.ts`: reads the stored ThemeChoice from localStorage,
 * validates `mode` and `palette`, and applies the resolved light|dark class
 * plus the `data-palette` attribute to <html> before first paint so the
 * correct shadcn tokens render with no flash of the wrong theme.
 *
 * Plain JS with no dependencies: it runs as a blocking script in <head>
 * before the app bundle hydrates. Any error falls back to the default theme.
 */
(() => {
	const STORAGE_KEY = "saif-theme";
	const MODES = ["light", "dark", "system"];
	const PALETTES = ["neutral", "blue", "green", "amber", "rose", "violet"];
	const DEFAULT_MODE = "system";
	const DEFAULT_PALETTE = "neutral";
	const DARK = "dark";
	const LIGHT = "light";

	let mode = DEFAULT_MODE;
	let palette = DEFAULT_PALETTE;
	try {
		const raw = globalThis.localStorage.getItem(STORAGE_KEY);
		if (raw !== null) {
			const parsed = JSON.parse(raw);
			if (typeof parsed === "object" && parsed !== null) {
				if (MODES.includes(parsed.mode)) {
					mode = parsed.mode;
				}
				if (PALETTES.includes(parsed.palette)) {
					palette = parsed.palette;
				}
			}
		}
	} catch {
		// Corrupt JSON or blocked storage access: keep the defaults.
	}

	const prefersDark =
		typeof globalThis.matchMedia === "function" &&
		globalThis.matchMedia("(prefers-color-scheme: dark)").matches;
	const resolved = mode === "system" ? (prefersDark ? DARK : LIGHT) : mode;

	const root = document.documentElement;
	root.classList.remove(DARK, LIGHT);
	root.classList.add(resolved);
	root.setAttribute("data-palette", palette);
})();
