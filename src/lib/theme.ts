/**
 * Theme primitives: mode (light/dark/system) and color palette selection over
 * the shadcn semantic tokens in `src/styles.css`. This module is DOM-only glue
 * plus the React context; it exports no components (see `src/components/`).
 */

import { createContext, useContext } from "react";

export type ThemeMode = "dark" | "light" | "system";

export type PaletteId = "amber" | "blue" | "green" | "neutral" | "rose" | "violet";

export interface ThemeChoice {
	mode: ThemeMode;
	palette: PaletteId;
}

export interface PaletteOption {
	id: PaletteId;
	label: string;
	/** Preview swatch for the switcher; tokens themselves live in styles.css. */
	swatch: string;
}

export const THEME_STORAGE_KEY = "saif-theme";

export const DEFAULT_THEME: ThemeChoice = { mode: "system", palette: "neutral" };

export const PALETTES: readonly PaletteOption[] = [
	{ id: "neutral", label: "Neutral", swatch: "#262626" },
	{ id: "blue", label: "Blue", swatch: "#2563eb" },
	{ id: "green", label: "Green", swatch: "#16a34a" },
	{ id: "amber", label: "Amber", swatch: "#d97706" },
	{ id: "rose", label: "Rose", swatch: "#e11d48" },
	{ id: "violet", label: "Violet", swatch: "#7c3aed" },
];

const MODES: readonly ThemeMode[] = ["dark", "light", "system"];

export const MODE_LABELS: Readonly<Record<ThemeMode, string>> = {
	dark: "Dark",
	light: "Light",
	system: "System",
};

export function isThemeMode(value: unknown): value is ThemeMode {
	return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

export function isPaletteId(value: unknown): value is PaletteId {
	return PALETTES.some((palette) => palette.id === value);
}

/** Parse a stored theme record, falling back to defaults on any invalid field. */
export function parseStoredTheme(raw: string | null): ThemeChoice {
	if (raw === null) {
		return DEFAULT_THEME;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) {
			return DEFAULT_THEME;
		}
		const record = parsed as Record<string, unknown>;
		return {
			mode: isThemeMode(record["mode"]) ? record["mode"] : DEFAULT_THEME.mode,
			palette: isPaletteId(record["palette"]) ? record["palette"] : DEFAULT_THEME.palette,
		};
	} catch {
		return DEFAULT_THEME;
	}
}

/** Resolve `system` against the OS preference. */
export function resolveMode(mode: ThemeMode, systemPrefersDark: boolean): "dark" | "light" {
	if (mode === "system") {
		return systemPrefersDark ? "dark" : "light";
	}
	return mode;
}

export function readStoredTheme(): ThemeChoice {
	if (typeof window === "undefined") {
		return DEFAULT_THEME;
	}
	return parseStoredTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
}

function systemPrefersDark(): boolean {
	return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Apply a theme choice to the document root (class + palette data attribute). */
export function applyTheme(choice: ThemeChoice): void {
	if (typeof document === "undefined") {
		return;
	}
	const root = document.documentElement;
	const resolved = resolveMode(choice.mode, systemPrefersDark());
	root.classList.remove("dark", "light");
	root.classList.add(resolved);
	root.dataset["palette"] = choice.palette;
}

export function storeTheme(choice: ThemeChoice): void {
	if (typeof window === "undefined") {
		return;
	}
	window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(choice));
}

export interface ThemeContextValue {
	choice: ThemeChoice;
	setChoice: (next: ThemeChoice) => void;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
	const value = useContext(ThemeContext);
	if (value === null) {
		throw new Error("useTheme must be used within a ThemeProvider");
	}
	return value;
}
