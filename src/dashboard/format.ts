/**
 * Number and timestamp formatting helpers for the dashboard. Non-component
 * module so `useComponentExportOnlyModules` stays satisfied in component files.
 */

const THOUSANDS = 1000;

export function formatCount(value: number): string {
	return value.toLocaleString("en-US");
}

export function formatUsd(value: number): string {
	return `$${value.toFixed(2)}`;
}

export function formatMs(value: number): string {
	return `${value} ms`;
}

export function formatTokens(value: number): string {
	if (value < THOUSANDS) {
		return `${value}`;
	}
	return `${(value / THOUSANDS).toFixed(1)}k`;
}

/** `used` against `limit` as a percentage, clamped for progress display. */
export function usagePercent(used: number, limit: number): number {
	if (limit <= 0) {
		return 0;
	}
	return Math.min(100, Math.round((used / limit) * 100));
}

export function formatTimestamp(iso: string): string {
	return `${iso.slice(0, 10)} ${iso.slice(11, 19)}Z`;
}
