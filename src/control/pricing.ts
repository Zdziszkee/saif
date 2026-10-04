/**
 * Model price table (gateway usage-accounting requirement).
 *
 * Prices come from the LiteLLM price map, fetched once and then cached for
 * `PRICE_CACHE_TTL_MS`. Only the per-model cost fields
 * (`input_cost_per_token`, `output_cost_per_token`) are kept — every other
 * field of the upstream document is dropped at load. An unknown model prices
 * to `null` (cost unknown), never to zero: a zero cost would silently settle
 * usage the provider will still bill for.
 *
 * Loading is fail-open on purpose: a failed refresh keeps the previous
 * entries (or an empty table on first load) so a pricing outage never blocks
 * completions. Traffic enforcement stays fail-closed in the pipeline; only
 * the cost annotation degrades to `null`.
 */

export interface ModelPrice {
	inputCostPerToken: number;
	outputCostPerToken: number;
}

export interface PricedUsage {
	completionTokens: number;
	promptTokens: number;
}

/** LiteLLM model price and context-window map. */
export const LITELLM_PRICE_URL =
	"https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** Price cache lifetime: one fetch per hour at most, shared across requests. */
export const PRICE_CACHE_TTL_MS = 3_600_000;

export interface PriceTableOptions {
	fetch?: typeof fetch | undefined;
	now?: (() => number) | undefined;
	ttlMs?: number | undefined;
	url?: string | undefined;
}

export interface PriceTable {
	/** Token cost in USD, or `null` when the model has no listed price. */
	costFor(model: string, usage: PricedUsage): number | null;
	/** Listed per-token price, or `undefined` for an unpriced model. */
	priceFor(model: string): ModelPrice | undefined;
	/**
	 * Load (or reload past-TTL) the table. TTL-cached and single-flight:
	 * concurrent callers share one fetch. Never rejects — a failed load
	 * keeps the previous entries.
	 */
	refresh(): Promise<void>;
}

interface PriceCache {
	entries: Map<string, ModelPrice>;
	inFlight: Promise<void> | undefined;
	loadedAt: number | undefined;
}

export function createPriceTable(options: PriceTableOptions = {}): PriceTable {
	const fetchFn = options.fetch ?? fetch;
	const now = options.now ?? Date.now;
	const ttlMs = options.ttlMs ?? PRICE_CACHE_TTL_MS;
	const url = options.url ?? LITELLM_PRICE_URL;
	const cache: PriceCache = { entries: new Map(), inFlight: undefined, loadedAt: undefined };

	async function load(): Promise<void> {
		try {
			const response = await fetchFn(url);
			if (!response.ok) {
				return;
			}
			cache.entries = parsePriceMap(await response.json());
		} catch {
			// Fail-open by design (see module docs): keep the previous entries.
		} finally {
			cache.loadedAt = now();
		}
	}

	function refresh(): Promise<void> {
		if (cache.loadedAt !== undefined && now() - cache.loadedAt < ttlMs) {
			return Promise.resolve();
		}
		cache.inFlight ??= load().finally(() => {
			cache.inFlight = undefined;
		});
		return cache.inFlight;
	}

	return {
		costFor: (model, usage) => {
			const price = cache.entries.get(model);
			return price === undefined ? null : computeCost(price, usage);
		},
		priceFor: (model) => cache.entries.get(model),
		refresh,
	};
}

/** Token cost in USD for priced usage. */
export function computeCost(price: ModelPrice, usage: PricedUsage): number {
	return (
		usage.promptTokens * price.inputCostPerToken + usage.completionTokens * price.outputCostPerToken
	);
}

/**
 * Keep per-model cost fields only. Anything without both non-negative
 * finite cost fields is dropped (unpriced), never defaulted to zero.
 */
function parsePriceMap(payload: unknown): Map<string, ModelPrice> {
	const entries = new Map<string, ModelPrice>();
	if (typeof payload !== "object" || payload === null) {
		return entries;
	}
	for (const [model, value] of Object.entries(payload)) {
		const price = parseModelPrice(value);
		if (price !== undefined) {
			entries.set(model, price);
		}
	}
	return entries;
}

function parseModelPrice(value: unknown): ModelPrice | undefined {
	if (typeof value !== "object" || value === null) {
		return;
	}
	// biome-ignore lint/style/useNamingConvention: LiteLLM price keys are snake_case by specification.
	const record = value as { input_cost_per_token?: unknown; output_cost_per_token?: unknown };
	const input = record.input_cost_per_token;
	const output = record.output_cost_per_token;
	if (typeof input !== "number" || typeof output !== "number") {
		return;
	}
	if (!(Number.isFinite(input) && Number.isFinite(output)) || input < 0 || output < 0) {
		return;
	}
	return { inputCostPerToken: input, outputCostPerToken: output };
}
