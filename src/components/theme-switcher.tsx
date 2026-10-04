import { CheckIcon, ChevronDownIcon, MonitorIcon, MoonIcon, PaletteIcon, SunIcon } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";
import {
	MODE_LABELS,
	PALETTES,
	type PaletteId,
	useTheme,
	type ThemeMode,
} from "#/lib/theme.ts";

const MODE_ICONS: Readonly<Record<ThemeMode, typeof SunIcon>> = {
	dark: MoonIcon,
	light: SunIcon,
	system: MonitorIcon,
};

const MODE_ORDER: readonly ThemeMode[] = ["light", "dark", "system"];
const PALETTE_SWATCH_CLASS =
	"size-2.5 shrink-0 rounded-full ring-1 ring-border";

/**
 * Theme switcher over the shadcn tokens: light/dark/system mode plus the
 * color palette presets defined in `src/styles.css`.
 */
export function ThemeSwitcher() {
	const { choice, setChoice } = useTheme();

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild={true}>
				<Button variant="outline" size="sm">
					<PaletteIcon />
					<span className="hidden sm:inline">{MODE_LABELS[choice.mode]}</span>
					<ChevronDownIcon />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-44">
				<DropdownMenuLabel>Appearance</DropdownMenuLabel>
				{MODE_ORDER.map((mode) => {
					const ModeIcon = MODE_ICONS[mode];
					return (
						<DropdownMenuItem key={mode} onSelect={() => setChoice({ ...choice, mode })}>
							<ModeIcon />
							<span className="flex-1">{MODE_LABELS[mode]}</span>
							{choice.mode === mode ? <CheckIcon /> : null}
						</DropdownMenuItem>
					);
				})}
				<DropdownMenuSeparator />
				<DropdownMenuLabel>Color palette</DropdownMenuLabel>
				{PALETTES.map((palette) => (
					<DropdownMenuItem
						key={palette.id}
						onSelect={() => setChoice({ ...choice, palette: palette.id as PaletteId })}
					>
						<span
							className={PALETTE_SWATCH_CLASS}
							style={{ backgroundColor: palette.swatch }}
							aria-hidden={true}
						/>
						<span className="flex-1">{palette.label}</span>
						{choice.palette === palette.id ? <CheckIcon /> : null}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
