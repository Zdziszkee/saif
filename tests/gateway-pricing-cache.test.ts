import { describe, expect, it } from "bun:test";
import type { PricingFetchFn } from "#/gateway/pricing.ts";
import { costFor, createPricingCache, loadPriceTable, priceFor } from "#/gateway/pricing.ts";

const TEST_URL = "https://example.invalid/prices.json";
const LONG_TTL_MS = 3_600_000;
const SHORT_TTL_MS = 10;
const SETTLE_MS = 50;
const FETCH_DELAY_MS = 30;
const COMPLETION_TOKENS = 500;
const EXPECTED_COST_USD = 0.0075;
const EXPECTED_MINI_COST_USD = 0.000_45;
const CLOSE_TO_PRECISION = 12;
const PROMPT_TOKENS = 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Hand-written stand-in for the LiteLLM pricing JSON: small but
 * shape-faithful. Kept as a JSON string so the snake_case wire keys do not
 * fight the naming lint, exactly like the policy sample fixtures.
 */
const FIXTURE_JSON = `{
	"azure/shared": {
		"input_cost_per_token": 0.000001,
		"litellm_provider": "azure",
		"output_cost_per_token": 0.000002
	},
	"broken-model": {
		"max_tokens": 4096,
		"mode": "chat"
	},
	"claude-3-5-sonnet": {
		"input_cost_per_token": 0.000003,
		"litellm_provider": "anthropic",
		"output_cost_per_token": 0.000015
	},
	"gpt-4o": {
		"cache_read_input_token_cost": 0.00000125,
		"input_cost_per_token": 0.0000025,
		"litellm_provider": "openai",
		"max_tokens": 128000,
		"mode": "chat",
		"output_cost_per_token": 0.00001,
		"supports_vision": true
	},
	"openai/shared": {
		"input_cost_per_token": 0.000001,
		"litellm_provider": "openai",
		"output_cost_per_token": 0.000002
	},
	"openai/unique-mini": {
		"input_cost_per_token": 0.00000015,
		"litellm_provider": "openai",
		"output_cost_per_token": 0.0000006
	},
	"sample_spec": {
		"input_cost_per_token": 0.000001,
		"litellm_provider": "openai",
		"output_cost_per_token": 0.000002
	},
	"weird": 42
}`;

const FIXTURE: unknown = JSON.parse(FIXTURE_JSON);

function stubFetch(payload: unknown): PricingFetchFn {
	return () => Promise.resolve({ json: () => Promise.resolve(payload) });
}

function delayedFetch(delayMs: number, payload: unknown): PricingFetchFn {
	return () => sleep(delayMs).then(() => ({ json: () => Promise.resolve(payload) }));
}

function failingFetch(message: string): PricingFetchFn {
	return () => Promise.reject(new Error(message));
}

describe("gateway pricing", () => {
	it("projects each model entry to cost fields and drops the rest", async () => {
		const table = await loadPriceTable({ fetchFn: stubFetch(FIXTURE), url: TEST_URL });

		expect(table["gpt-4o"]).toEqual({
			inputPerToken: 0.000_002_5,
			outputPerToken: 0.000_01,
			provider: "openai",
		});
		// biome-ignore lint/complexity/useLiteralKeys: tsc noPropertyAccessFromIndexSignature (TS4111) requires bracket access on PriceTable.
		expect(table["sample_spec"]).toBeUndefined();
		expect(table["broken-model"]).toBeUndefined();
		// biome-ignore lint/complexity/useLiteralKeys: tsc noPropertyAccessFromIndexSignature (TS4111) requires bracket access on PriceTable.
		expect(table["weird"]).toBeUndefined();
		expect(Object.keys(table).sort()).toEqual([
			"azure/shared",
			"claude-3-5-sonnet",
			"gpt-4o",
			"openai/shared",
			"openai/unique-mini",
		]);
	});

	it("resolves the exact key first", async () => {
		const table = await loadPriceTable({ fetchFn: stubFetch(FIXTURE), url: TEST_URL });

		expect(priceFor(table, "gpt-4o")).toEqual({
			inputPerToken: 0.000_002_5,
			outputPerToken: 0.000_01,
		});
		expect(priceFor(table, "openai/shared")).toEqual({
			inputPerToken: 0.000_001,
			outputPerToken: 0.000_002,
		});
	});

	it("strips a trailing date suffix and retries", async () => {
		const table = await loadPriceTable({ fetchFn: stubFetch(FIXTURE), url: TEST_URL });

		expect(priceFor(table, "claude-3-5-sonnet-2024-10-22")).toEqual({
			inputPerToken: 0.000_003,
			outputPerToken: 0.000_015,
		});
		expect(priceFor(table, "no-such-model-2024-01-01")).toBeNull();
	});

	it("falls back to a lone provider-prefixed key but never guesses across providers", async () => {
		const table = await loadPriceTable({ fetchFn: stubFetch(FIXTURE), url: TEST_URL });

		expect(priceFor(table, "unique-mini")).toEqual({
			inputPerToken: 0.000_000_15,
			outputPerToken: 0.000_000_6,
		});
		expect(priceFor(table, "shared")).toBeNull();
		expect(priceFor(table, "azure/unknown-model")).toBeNull();
	});

	it("prices known models and marks unknown ones unpriced instead of zero", async () => {
		const table = await loadPriceTable({ fetchFn: stubFetch(FIXTURE), url: TEST_URL });

		const known = costFor(table, "gpt-4o", PROMPT_TOKENS, COMPLETION_TOKENS);
		if (!("costUsd" in known)) {
			throw new Error("expected gpt-4o to be priced");
		}
		expect(known.costUsd).toBeCloseTo(EXPECTED_COST_USD, CLOSE_TO_PRECISION);

		const mini = costFor(table, "unique-mini", PROMPT_TOKENS, COMPLETION_TOKENS);
		if (!("costUsd" in mini)) {
			throw new Error("expected unique-mini to resolve through its provider key");
		}
		expect(mini.costUsd).toBeCloseTo(EXPECTED_MINI_COST_USD, CLOSE_TO_PRECISION);

		expect(costFor(table, "no-such-model", PROMPT_TOKENS, COMPLETION_TOKENS)).toEqual({
			priced: false,
		});
	});

	it("serves an empty table until the first load resolves, without blocking", async () => {
		const cache = createPricingCache({
			fetchFn: delayedFetch(FETCH_DELAY_MS, FIXTURE),
			ttlMs: LONG_TTL_MS,
			url: TEST_URL,
		});

		expect(await cache.get()).toEqual({});
		await sleep(SETTLE_MS);

		expect((await cache.get())["gpt-4o"]).toBeDefined();
		expect(cache.lastError()).toBeNull();
	});

	it("records load failures without throwing and keeps serving the table", async () => {
		const cache = createPricingCache({
			fetchFn: failingFetch("pricing endpoint down"),
			ttlMs: LONG_TTL_MS,
			url: TEST_URL,
		});

		await sleep(SETTLE_MS);
		expect(await cache.get()).toEqual({});
		expect(cache.lastError()).toContain("pricing endpoint down");
	});

	it("keeps serving the last good table when a TTL refresh fails", async () => {
		let shouldFail = false;
		const fetchFn: PricingFetchFn = () => {
			if (shouldFail) {
				return Promise.reject(new Error("refresh failed"));
			}
			return Promise.resolve({ json: () => Promise.resolve(FIXTURE) });
		};
		const cache = createPricingCache({ fetchFn, ttlMs: SHORT_TTL_MS, url: TEST_URL });

		await sleep(SETTLE_MS);
		const fresh = await cache.get();
		expect(fresh["gpt-4o"]).toBeDefined();
		expect(cache.lastError()).toBeNull();

		shouldFail = true;
		await sleep(SHORT_TTL_MS + SETTLE_MS);
		const stale = await cache.get();
		expect(stale).toEqual(fresh);
		await sleep(SETTLE_MS);
		expect(cache.lastError()).toContain("refresh failed");
		expect(await cache.get()).toEqual(fresh);
	});
});
