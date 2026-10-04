// biome-ignore-all lint/style/useNamingConvention: LiteLLM wire-format keys are snake_case by specification.
import { describe, expect, it } from "bun:test";
import {
	computeCost,
	createPriceTable,
	LITELLM_PRICE_URL,
	type PriceTable,
} from "#/control/pricing.ts";

const LITELLM_DOCUMENT = {
	"gpt-4": {
		input_cost_per_token: 0.000_03,
		max_input_tokens: 8192,
		output_cost_per_token: 0.000_06,
	},
	"priced-model": {
		input_cost_per_token: 0.000_001,
		output_cost_per_token: 0.000_002,
	},
	"unpriced-model": {
		max_input_tokens: 4096,
	},
	"zero-cost-model": {
		input_cost_per_token: 0,
		output_cost_per_token: 0,
	},
};

function priceFetch(document: unknown, seen: string[]): typeof fetch {
	return ((url: unknown) => {
		seen.push(String(url));
		return Promise.resolve(Response.json(document));
	}) as unknown as typeof fetch;
}

describe("price table", () => {
	it("fetches the LiteLLM map from the default URL", async () => {
		const seen: string[] = [];
		const table = createPriceTable({ fetch: priceFetch(LITELLM_DOCUMENT, seen) });
		await table.refresh();
		expect(seen).toEqual([LITELLM_PRICE_URL]);
		expect(table.priceFor("priced-model")).toEqual({
			inputCostPerToken: 0.000_001,
			outputCostPerToken: 0.000_002,
		});
	});

	it("prices prompt and completion tokens separately", async () => {
		const seen: string[] = [];
		const table = createPriceTable({ fetch: priceFetch(LITELLM_DOCUMENT, seen) });
		await table.refresh();
		expect(table.costFor("priced-model", { completionTokens: 100, promptTokens: 200 })).toBeCloseTo(
			0.0004,
		);
		expect(
			computeCost(
				{ inputCostPerToken: 0.5, outputCostPerToken: 1.5 },
				{ completionTokens: 2, promptTokens: 4 },
			),
		).toBe(5);
	});

	it("keeps only the per-model cost fields", async () => {
		const seen: string[] = [];
		const table = createPriceTable({ fetch: priceFetch(LITELLM_DOCUMENT, seen) });
		await table.refresh();
		const price = table.priceFor("gpt-4");
		expect(Object.keys(price ?? {}).sort()).toEqual(["inputCostPerToken", "outputCostPerToken"]);
	});

	it("prices unknown and unpriced models to null, never zero", async () => {
		const seen: string[] = [];
		const table = createPriceTable({ fetch: priceFetch(LITELLM_DOCUMENT, seen) });
		await table.refresh();
		expect(table.priceFor("no-such-model")).toBeUndefined();
		expect(
			table.costFor("no-such-model", { completionTokens: 1000, promptTokens: 1000 }),
		).toBeNull();
		expect(
			table.costFor("unpriced-model", { completionTokens: 1000, promptTokens: 1000 }),
		).toBeNull();
	});

	it("fetches once within the TTL and refetches past it", async () => {
		const seen: string[] = [];
		let clock = 1_000_000;
		const table = createPriceTable({
			fetch: priceFetch(LITELLM_DOCUMENT, seen),
			now: () => clock,
			ttlMs: 60_000,
		});
		await table.refresh();
		await table.refresh();
		expect(seen).toHaveLength(1);
		clock += 59_999;
		await table.refresh();
		expect(seen).toHaveLength(1);
		clock += 1;
		await table.refresh();
		expect(seen).toHaveLength(2);
	});

	it("shares one fetch across concurrent refreshes", async () => {
		const seen: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const slowFetch = ((_url: unknown) => {
			seen.push("fetch");
			return gate.then(() => Response.json(LITELLM_DOCUMENT));
		}) as typeof fetch;
		const table: PriceTable = createPriceTable({ fetch: slowFetch });
		const pending = Promise.all([table.refresh(), table.refresh(), table.refresh()]);
		release();
		await pending;
		expect(seen).toHaveLength(1);
	});

	it("fails open to null costs when the price fetch fails", async () => {
		const failing = ((_url: unknown) => Promise.reject(new Error("offline"))) as typeof fetch;
		const table = createPriceTable({ fetch: failing });
		await table.refresh();
		expect(table.costFor("gpt-4", { completionTokens: 10, promptTokens: 10 })).toBeNull();
	});

	it("keeps serving stale entries when a reload fails", async () => {
		let clock = 0;
		let fail = false;
		const flaky = ((): Promise<Response> => {
			if (fail) {
				throw new Error("offline");
			}
			return Promise.resolve(Response.json(LITELLM_DOCUMENT));
		}) as unknown as typeof fetch;
		const table = createPriceTable({ fetch: flaky, now: () => clock, ttlMs: 1000 });
		await table.refresh();
		expect(table.priceFor("gpt-4")).not.toBeUndefined();
		fail = true;
		clock += 2000;
		await table.refresh();
		expect(table.priceFor("gpt-4")).not.toBeUndefined();
	});
});
