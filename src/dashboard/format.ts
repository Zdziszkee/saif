/**
 * Number and timestamp formatting helpers for the dashboard. Non-component
 * module so `useComponentExportOnlyModules` stays satisfied in component files.
 */

const FULL_PERCENT = 100;
const THOUSANDS = 1000;
const CENTS_DIGITS = 2;
const TENTHS_DIGITS = 1;
const ISO_DATE_END = 10;
const ISO_TIME_START = 11;
const ISO_TIME_END = 19;
const TIME_LABEL_LENGTH = 5;
const TRAILING_POINT_ZERO = /\.0$/;

export function formatCount(value: number): string {
	return value.toLocaleString("en-US");
}

export function formatUsd(value: number): string {
	return `$${value.toFixed(CENTS_DIGITS)}`;
}

export function formatMs(value: number): string {
	return `${value} ms`;
}

export function formatTokens(value: number): string {
	if (value < THOUSANDS) {
		return `${value}`;
	}
	return `${(value / THOUSANDS).toFixed(TENTHS_DIGITS)}k`;
}

/** Compact USD for chart axes: `$0`, `$1.20`, `$12.4k`. Never groups digits. */
export function formatUsdCompact(value: number): string {
	if (!Number.isFinite(value)) {
		return "?";
	}
	if (Math.abs(value) >= THOUSANDS) {
		return `$${(value / THOUSANDS).toFixed(TENTHS_DIGITS).replace(TRAILING_POINT_ZERO, "")}k`;
	}
	return formatUsd(value);
}

/** `used` against `limit` as a percentage, clamped for progress display. */
export function usagePercent(used: number, limit: number): number {
	if (limit <= 0) {
		return 0;
	}
	return Math.min(FULL_PERCENT, Math.round((used / limit) * FULL_PERCENT));
}

/** `2026-10-03 18:42:11Z` from an ISO timestamp. */
export function formatTimestamp(iso: string): string {
	return `${iso.slice(0, ISO_DATE_END)} ${iso.slice(ISO_TIME_START, ISO_TIME_END)}Z`;
}

/** `18:42` from an ISO timestamp, for chart axes. */
export function formatTimeLabel(iso: string): string {
	return iso.slice(ISO_TIME_START, ISO_TIME_START + TIME_LABEL_LENGTH);
}
