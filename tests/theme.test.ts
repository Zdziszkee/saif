/**
 * Theme primitive tests (saif 11.x): stored-theme parsing, mode resolution,
 * and the ThemeMode/PaletteId type guards in `src/lib/theme.ts`.
 */
import { describe, expect, it } from "bun:test";
import {
	DEFAULT_THEME,
	isPaletteId,
	isThemeMode,
	MODE_LABELS,
	PALETTES,
	type PaletteId,
	parseStoredTheme,
	resolveMode,
	type ThemeChoice,
	type ThemeMode,
} from "#/lib/theme.ts";

const ALL_MODES: readonly ThemeMode[] = ["dark", "light", "system"];
const ALL_PALETTE_IDS: readonly PaletteId[] = PALETTES.map((palette) => palette.id);

describe("parseStoredTheme", () => {
	it("accepts a valid stored theme record", () => {
		const stored = JSON.stringify({ mode: "dark", palette: "blue" });
		expect(parseStoredTheme(stored)).toEqual({ mode: "dark", palette: "blue" });
	});

	it("accepts every documented mode and palette id", () => {
		for (const mode of ALL_MODES) {
			for (const palette of ALL_PALETTE_IDS) {
				const choice: ThemeChoice = { mode, palette };
				expect(parseStoredTheme(JSON.stringify(choice))).toEqual(choice);
			}
		}
	});

	it("round-trips the default theme", () => {
		expect(parseStoredTheme(JSON.stringify(DEFAULT_THEME))).toEqual(DEFAULT_THEME);
	});

	it("falls back to the defaults when nothing is stored", () => {
		expect(parseStoredTheme(null)).toEqual({ mode: "system", palette: "neutral" });
	});

	it("falls back to the defaults on unparseable input", () => {
		for (const raw of ["", "not json", "{", "[", "}{"]) {
			expect(parseStoredTheme(raw)).toEqual(DEFAULT_THEME);
		}
	});

	it("falls back to the defaults on non-object JSON", () => {
		for (const raw of ['"theme"', "42", "true", "null", "[]"]) {
			expect(parseStoredTheme(raw)).toEqual(DEFAULT_THEME);
		}
	});

	it("replaces only the invalid field", () => {
		expect(parseStoredTheme(JSON.stringify({ mode: "dark", palette: "neon" }))).toEqual({
			mode: "dark",
			palette: "neutral",
		});
		expect(parseStoredTheme(JSON.stringify({ mode: "sepia", palette: "rose" }))).toEqual({
			mode: "system",
			palette: "rose",
		});
		expect(parseStoredTheme(JSON.stringify({ mode: 3, palette: ["blue"] }))).toEqual(DEFAULT_THEME);
	});

	it("ignores unknown fields", () => {
		const stored = JSON.stringify({ extra: true, mode: "light", palette: "green", version: 9 });
		expect(parseStoredTheme(stored)).toEqual({ mode: "light", palette: "green" });
	});
});

describe("resolveMode", () => {
	it("maps system to the OS preference", () => {
		expect(resolveMode("system", true)).toBe("dark");
		expect(resolveMode("system", false)).toBe("light");
	});

	it("passes explicit modes through regardless of the OS preference", () => {
		for (const prefersDark of [true, false]) {
			expect(resolveMode("dark", prefersDark)).toBe("dark");
			expect(resolveMode("light", prefersDark)).toBe("light");
		}
	});
});

describe("theme type guards", () => {
	it("isThemeMode accepts the documented modes", () => {
		for (const mode of ALL_MODES) {
			expect(isThemeMode(mode)).toBe(true);
		}
	});

	it("isThemeMode rejects other values", () => {
		for (const value of ["Dark", " dark", "sepia", "", 3, null, undefined, { mode: "dark" }]) {
			expect(isThemeMode(value)).toBe(false);
		}
	});

	it("isPaletteId accepts the palette table ids", () => {
		for (const palette of ALL_PALETTE_IDS) {
			expect(isPaletteId(palette)).toBe(true);
		}
		expect(ALL_PALETTE_IDS).toEqual(["neutral", "blue", "green", "amber", "rose", "violet"]);
	});

	it("isPaletteId rejects other values", () => {
		for (const value of ["teal", "Blue", "", 3, null, undefined, ["blue"]]) {
			expect(isPaletteId(value)).toBe(false);
		}
	});

	it("labels every mode", () => {
		for (const mode of ALL_MODES) {
			expect(MODE_LABELS[mode].length).toBeGreaterThan(0);
		}
	});
});
