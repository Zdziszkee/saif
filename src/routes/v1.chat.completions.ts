import { createFileRoute } from "@tanstack/react-router";
import { FilePolicySource, PolicyLoader, type PolicySnapshot } from "#/control/policy/loader.ts";
import { SEMANTIC_DEFAULTS } from "#/control/semantic/index.ts";
import { createGatewayStore } from "#/db/repositories.ts";
import { env } from "#/env.ts";
import {
	HTTP_INTERNAL_ERROR,
	HTTP_SERVICE_UNAVAILABLE,
	openAiError,
	type PriceForModel,
	runGatewayTurn,
} from "#/gateway/lifecycle.ts";
import { createPricingCache, type PriceTable, priceFor } from "#/gateway/pricing.ts";
import type { GatewayStore } from "#/gateway/store.ts";
import { getHub } from "#/hub/runtime.ts";
import { describeError } from "#/lib/errors.ts";

/**
 * OpenAI-compatible gateway (`POST /v1/chat/completions`): an agent harness
 * points its `baseURL` here and receives SSE streaming completions. The route
 * is thin by design — it assembles production dependencies and delegates the
 * identity, budget, validation, and settle lifecycle to `runGatewayTurn()`.
 */

const POLICY_PATH = "policy.json";

const gatewayPolicyLoader = new PolicyLoader(new FilePolicySource(POLICY_PATH));
let gatewayPolicyStarted = false;

async function getPolicySnapshot(): Promise<PolicySnapshot | undefined> {
	if (!gatewayPolicyStarted) {
		gatewayPolicyStarted = true;
		await gatewayPolicyLoader.start();
	}
	return gatewayPolicyLoader.snapshot;
}

let gatewayStore: GatewayStore | undefined;

async function getGatewayStore(): Promise<GatewayStore> {
	if (gatewayStore === undefined) {
		const { db } = await import("#/db/index.ts");
		gatewayStore = createGatewayStore(db);
	}
	return gatewayStore;
}

const MS_PER_HOUR = 3_600_000;

/**
 * Live price table, refreshed in the background. Starts empty so an import
 * or a cold start never blocks a request on a multi-megabyte fetch: until the
 * first load resolves, every model settles as unpriced rather than guessing.
 */
let currentTable: PriceTable = {};
let pricingStarted = false;

function currentPriceFor(): PriceForModel {
	if (!pricingStarted) {
		pricingStarted = true;
		refreshPricingLoop().catch(() => undefined);
	}
	return (model) => priceFor(currentTable, model);
}

async function refreshPricingLoop(): Promise<void> {
	const cache = createPricingCache({
		ttlMs: env.PRICING_TTL_HOURS * MS_PER_HOUR,
		url: env.PRICING_JSON_URL,
	});
	for (;;) {
		try {
			// biome-ignore lint/performance/noAwaitInLoops: refresh cadence is sequential by design; overlapping refreshes would race the shared table reference
			currentTable = await cache.get();
		} catch {
			// createPricingCache records failures on lastError() and keeps the
			// last good table; this loop only advances the shared reference.
		}
		await new Promise((resolve) => setTimeout(resolve, env.PRICING_TTL_HOURS * MS_PER_HOUR));
	}
}

async function handle(request: Request): Promise<Response> {
	const baseUrl = env.MODEL_BASE_URL;
	if (baseUrl === undefined) {
		return openAiError(
			HTTP_INTERNAL_ERROR,
			"model upstream is not configured",
			"server_error",
			"upstream-unconfigured",
		);
	}
	const hub = await getHub();
	const snapshot = await getPolicySnapshot();
	if (snapshot === undefined) {
		return openAiError(
			HTTP_SERVICE_UNAVAILABLE,
			"policy is unavailable",
			"server_error",
			"policy-unavailable",
		);
	}
	let store: GatewayStore;
	try {
		store = await getGatewayStore();
	} catch (error) {
		return openAiError(
			HTTP_INTERNAL_ERROR,
			`gateway store unavailable: ${describeError(error)}`,
			"server_error",
			"store-unavailable",
		);
	}
	return runGatewayTurn({
		identity: hub.identity,
		pipeline: hub.pipeline,
		policy: { budget: snapshot.policy.controls.budget, policyVersion: snapshot.policyVersion },
		priceFor: currentPriceFor(),
		request,
		semanticConfig: SEMANTIC_DEFAULTS,
		store,
		upstream: { apiKey: env.MODEL_API_KEY, baseUrl, defaultModel: env.MODEL_NAME },
	});
}

export const Route = createFileRoute("/v1/chat/completions")({
	server: {
		handlers: {
			POST: ({ request }) => handle(request),
		},
	},
});
