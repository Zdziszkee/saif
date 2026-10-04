/**
 * Model price table for usage accounting (gateway currency requirement).
 *
 * Costs come from the open-source LiteLLM `model_prices_and_context_window`
 * document fetched at runtime — never hard-coded. Only per-token cost
 * fields are kept. A model absent from the table (or an unreachable table)
 * records cost as unknown (`null`), never zero, so totals cannot silently
 * under-report spend.
 */

import { z } from "zod";
import type { FetchLike } from "./openai.ts";

const LITELLM_PRICES_URL =
	"https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const priceEntrySchema = z.looseObject({
	input_cost_per_token: z.number().nonnegative().optional(),
	output_cost_per_token: z.number().nonnegative().optional(),
});

export interface ModelPrice {
	inputPerToken: number;
	outputPerToken: number;
}

export type ModelPriceTable = Readonly<Record<string, ModelPrice>>;

/** Keep only priced models with both directions present. */
export function parsePriceTable(document: unknown): ModelPriceTable {
	if (typeof document !== "object" || document === null) {
		return {};
	}
	const table: Record<string, ModelPrice> = {};
	for (const [model, raw] of Object.entries(document)) {
		const entry = priceEntrySchema.safeParse(raw);
		if (
			!entry.success ||
			entry.data.input_cost_per_token === undefined ||
			entry.data.output_cost_per_token === undefined
		) {
			continue;
		}
		table[model] = {
			inputPerToken: entry.data.input_cost_per_token,
			outputPerToken: entry.data.output_cost_per_token,
		};
	}
	return table;
}

/** Cost in USD, or null when the model is absent from the table. */
export function costForModel(
	table: ModelPriceTable | null,
	model: string,
	promptTokens: number,
	completionTokens: number,
): number | null {
	const price = table?.[model];
	if (price === undefined) {
		return null;
	}
	return promptTokens * price.inputPerToken + completionTokens * price.outputPerToken;
}

/** Fetch and parse the LiteLLM table; throws on transport or shape failure. */
export async function fetchPriceTable(
	fetchImpl: FetchLike,
	url: string = LITELLM_PRICES_URL,
): Promise<ModelPriceTable> {
	const response = await fetchImpl(url);
	if (!response.ok) {
		throw new Error(`price table request failed with status ${response.status}`);
	}
	const document: unknown = await response.json();
	const table = parsePriceTable(document);
	if (Object.keys(table).length === 0) {
		throw new Error("price table contained no usable model prices");
	}
	return table;
}
