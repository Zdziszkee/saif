/**
 * Per-model token price table for gateway cost accounting.
 *
 * The source is the open-source LiteLLM pricing JSON, fetched once at
 * startup and projected down to per-token costs. This module stays pure:
 * the price-table URL and refresh TTL are constructor params, so callers
 * read `PRICING_JSON_URL` / `PRICING_TTL_HOURS` from `src/env.ts` and pass
 * them in. Nothing here imports env or touches the network directly in a
 * way tests cannot stub via `fetchFn`.
 */

export interface PriceEntry {
	inputPerToken: number;
	outputPerToken: number;
	provider: string;
}

export type PriceTable = Readonly<Record<string, PriceEntry>>;

export interface PriceLookup {
	inputPerToken: number;
	outputPerToken: number;
}

export type CostResult = { costUsd: number } | { priced: false };

export type PricingFetchFn = (url: string) => Promise<{ json(): Promise<unknown> }>;

export interface LoadPriceTableOptions {
	fetchFn?: PricingFetchFn | undefined;
	url: string;
}

export interface PricingCacheOptions {
	fetchFn?: PricingFetchFn | undefined;
	ttlMs: number;
	url: string;
}

export interface PricingCache {
	get(): Promise<PriceTable>;
	lastError(): string | null;
}

const DATE_SUFFIX_PATTERN = /-\d{4}-\d{2}-\d{2}$/;
const DEFAULT_FETCH: PricingFetchFn = (url) => globalThis.fetch(url);
const INPUT_COST_KEY = "input_cost_per_token";
const OUTPUT_COST_KEY = "output_cost_per_token";
const PROVIDER_KEY = "litellm_provider";
const SAMPLE_SPEC_KEY = "sample_spec";
const SLASH_SEPARATOR = "/";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function toPriceEntry(value: Record<string, unknown>): PriceEntry | null {
	const inputPerToken = value[INPUT_COST_KEY];
	const outputPerToken = value[OUTPUT_COST_KEY];
	const provider = value[PROVIDER_KEY];
	if (typeof inputPerToken !== "number" || typeof outputPerToken !== "number") {
		return null;
	}
	if (typeof provider !== "string") {
		return null;
	}
	if (!(Number.isFinite(inputPerToken) && Number.isFinite(outputPerToken))) {
		return null;
	}
	return { inputPerToken, outputPerToken, provider };
}

function toLookup(entry: PriceEntry): PriceLookup {
	return { inputPerToken: entry.inputPerToken, outputPerToken: entry.outputPerToken };
}

/**
 * Fetch the LiteLLM pricing JSON and project each model entry down to
 * per-token costs. Skips the `sample_spec` key, non-object entries, and
 * models missing numeric cost fields or a provider string.
 */
export async function loadPriceTable(options: LoadPriceTableOptions): Promise<PriceTable> {
	const fetchFn = options.fetchFn ?? DEFAULT_FETCH;
	const response = await fetchFn(options.url);
	const raw = await response.json();
	if (!isRecord(raw)) {
		return {};
	}
	const table: Record<string, PriceEntry> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (key === SAMPLE_SPEC_KEY) {
			continue;
		}
		if (!isRecord(value)) {
			continue;
		}
		const entry = toPriceEntry(value);
		if (entry === null) {
			continue;
		}
		table[key] = entry;
	}
	return table;
}

/**
 * Resolve per-token prices for a model id. Tries the exact key, then the
 * key with a trailing `-YYYY-MM-DD` date suffix stripped, then a single
 * `<provider>/<model>` table key when `model` has no slash. Returns `null`
 * when unknown or when several providers share the same suffix (never
 * guesses across providers).
 */
export function priceFor(table: PriceTable, model: string): PriceLookup | null {
	const exact = table[model];
	if (exact !== undefined) {
		return toLookup(exact);
	}
	const base = model.replace(DATE_SUFFIX_PATTERN, "");
	if (base !== model) {
		const dated = table[base];
		if (dated !== undefined) {
			return toLookup(dated);
		}
	}
	if (base.includes(SLASH_SEPARATOR)) {
		return null;
	}
	let match: PriceLookup | null = null;
	for (const [key, entry] of Object.entries(table)) {
		if (key.endsWith(`${SLASH_SEPARATOR}${base}`)) {
			if (match !== null) {
				return null;
			}
			match = toLookup(entry);
		}
	}
	return match;
}

/**
 * Token cost in USD for a model. Unknown models yield `{ priced: false }`
 * — never a fake zero — so callers can leave the usage row unpriced.
 */
export function costFor(
	table: PriceTable,
	model: string,
	promptTokens: number,
	completionTokens: number,
): CostResult {
	const price = priceFor(table, model);
	if (price === null) {
		return { priced: false };
	}
	return {
		costUsd: promptTokens * price.inputPerToken + completionTokens * price.outputPerToken,
	};
}

/**
 * Background-refreshing price-table cache for the request path.
 *
 * Fires one load at construction and serves the last good table from
 * `get()` without ever blocking on the network: callers see an empty
 * table until the first load resolves, and stale data while a refresh is
 * in flight. Failed loads keep the previous table and record the error
 * in `lastError()`; `get()` never throws.
 */
export function createPricingCache(options: PricingCacheOptions): PricingCache {
	let current: PriceTable = {};
	let error: string | null = null;
	let expiresAt = 0;
	let inFlight: Promise<void> | null = null;

	async function refresh(): Promise<void> {
		try {
			current = await loadPriceTable({ fetchFn: options.fetchFn, url: options.url });
			error = null;
			expiresAt = Date.now() + options.ttlMs;
		} catch (unknownError) {
			error = unknownError instanceof Error ? unknownError.message : String(unknownError);
		} finally {
			inFlight = null;
		}
	}

	function ensureFresh(): void {
		if (inFlight !== null) {
			return;
		}
		if (Date.now() < expiresAt) {
			return;
		}
		inFlight = refresh();
	}

	function get(): Promise<PriceTable> {
		ensureFresh();
		return Promise.resolve(current);
	}

	function lastError(): string | null {
		return error;
	}

	ensureFresh();
	return { get, lastError };
}
