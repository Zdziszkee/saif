import { useCallback, useEffect, useMemo, useState } from "react";
import {
	applyTheme,
	DEFAULT_THEME,
	readStoredTheme,
	storeTheme,
	type ThemeChoice,
	ThemeContext,
} from "#/lib/theme.ts";

/**
 * Theme provider over the shadcn CSS-variable tokens. The pre-hydration
 * bootstrap script in `__root.tsx` has already applied the stored theme to
 * `documentElement`, so state starts at the defaults to match SSR markup and
 * syncs after mount; every change is re-applied and persisted.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
	const [choice, setChoiceState] = useState<ThemeChoice>(DEFAULT_THEME);

	useEffect(() => {
		const stored = readStoredTheme();
		setChoiceState(stored);
		applyTheme(stored);
	}, []);

	useEffect(() => {
		const media = globalThis.matchMedia("(prefers-color-scheme: dark)");
		const onChange = () => {
			setChoiceState((current) => {
				applyTheme(current);
				return current;
			});
		};
		media.addEventListener("change", onChange);
		return () => {
			media.removeEventListener("change", onChange);
		};
	}, []);

	const setChoice = useCallback((next: ThemeChoice) => {
		setChoiceState(next);
		applyTheme(next);
		storeTheme(next);
	}, []);

	const value = useMemo(() => ({ choice, setChoice }), [choice, setChoice]);

	return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
