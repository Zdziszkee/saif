/**
 * HTTP-surface tests for the LLM gateway route (`POST /v1/chat/completions`).
 *
 * These tests drive `runGatewayTurn` — the same handler the route file
 * delegates to — as a Request-to-Response black box with a stubbed fetch, a
 * fake store, and fixture pipelines. No network, no credentials, no Jev.
 * The focus here is the wire contract: OpenAI error envelopes, SSE framing,
 * prompt concatenation, and upstream body shaping.
 */

import { describe, expect, it } from "bun:test";
import type { SemanticConfig } from "#/control/semantic/index.ts";
import { USER_GROUP_ID_HEADER, USER_ID_HEADER } from "#/control/subjects.ts";
import type { ControlPipeline, Interaction } from "#/control/types.ts";
import { type GatewayTurnDeps, runGatewayTurn } from "#/gateway/lifecycle.ts";
import type {
	GatewayAuditRow,
	GatewayStore,
	GatewayUsageRow,
	SpendSummary,
} from "#/gateway/store.ts";
import type { FetchImpl } from "#/gateway/upstream.ts";
import { identityResolver, pipelineWith } from "./helpers/fixtures.ts";

const IMAGE_PART_TYPE = "image_url";
const IMAGE_URL_KEY = "image_url";
const STREAM_OPTIONS_KEY = "stream_options";
const INCLUDE_USAGE_KEY = "include_usage";
const DELTA_CHUNK = `{"id":"chatcmpl-9","object":"chat.completion.chunk","created":2,"model":"wire-model","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}`;
const USAGE_CHUNK = `{"id":"chatcmpl-9","object":"chat.completion.chunk","created":2,"model":"wire-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}`;

class FakeGatewayStore implements GatewayStore {
	audits: (GatewayAuditRow & { id: number })[] = [];
	usages: (GatewayUsageRow & { id: number })[] = [];

	poll() {
		return Promise.resolve({ events: [], usage: [] });
	}

	recordAudit(row: GatewayAuditRow): number {
		const id = this.audits.length + 1;
		this.audits.push({ ...row, id });
		return id;
	}

	recordUsage(row: GatewayUsageRow): number {
		const id = this.usages.length + 1;
		this.usages.push({ ...row, id });
		return id;
	}

	spendSince(): SpendSummary {
		return { costUsd: 0, tokens: 0, unpricedTokens: 0 };
	}
}

function semanticConfig(): SemanticConfig {
	return {
		checks: [],
		floors: { decisiveness: 0.9 },
		groups: { hr: [], manager: [] },
		maxChars: 4000,
		model: "fixture-judge",
		timeoutMs: 5000,
	};
}

function gatewayRequest(body: unknown): Request {
	return new Request("http://test.local/v1/chat/completions", {
		body: JSON.stringify(body),
		headers: {
			"content-type": "application/json",
			[USER_GROUP_ID_HEADER]: "hr",
			[USER_ID_HEADER]: "route-user",
		},
		method: "POST",
	});
}

interface SeenUpstream {
	bodies: unknown[];
	urls: string[];
}

function stubFetch(payloads: string[]): { fetchImpl: FetchImpl; seen: SeenUpstream } {
	const seen: SeenUpstream = { bodies: [], urls: [] };
	const fetchImpl: FetchImpl = (input, init) => {
		seen.urls.push(String(input));
		if (init?.body !== undefined) {
			seen.bodies.push(JSON.parse(String(init.body)) as unknown);
		}
		return Promise.resolve(
			new Response(payloads.map((payload) => `data: ${payload}\n\n`).join(""), { status: 200 }),
		);
	};
	return { fetchImpl, seen };
}

interface WireInput {
	body: unknown;
	defaultModel?: string | undefined;
	fetchImpl?: FetchImpl;
	pipeline?: ControlPipeline;
}

function wireTurn(input: WireInput): {
	deps: GatewayTurnDeps;
	seen: SeenUpstream;
	store: FakeGatewayStore;
} {
	const { fetchImpl, seen } =
		input.fetchImpl === undefined
			? stubFetch([DELTA_CHUNK, USAGE_CHUNK, "[DONE]"])
			: { fetchImpl: input.fetchImpl, seen: { bodies: [], urls: [] } };
	const store = new FakeGatewayStore();
	const deps: GatewayTurnDeps = {
		fetchImpl,
		identity: identityResolver(),
		pipeline: input.pipeline ?? pipelineWith([]),
		policy: { budget: { overBudgetVerdict: "block", rules: [] }, policyVersion: "wire-policy" },
		priceFor: () => null,
		request: gatewayRequest(input.body),
		semanticConfig: semanticConfig(),
		store,
		upstream: {
			apiKey: "wire-key",
			baseUrl: "https://wire.test",
			defaultModel: input.defaultModel ?? "wire-model",
		},
	};
	return { deps, seen, store };
}

interface OpenAiErrorBody {
	error: { code: string; message: string; type: string };
}

async function errorOf(response: Response): Promise<OpenAiErrorBody["error"]> {
	return ((await response.json()) as OpenAiErrorBody).error;
}

interface WireUpstreamBody {
	messages: unknown;
	model: unknown;
	stream: unknown;
}

function upstreamBody(seen: SeenUpstream): WireUpstreamBody & Record<string, unknown> {
	const first = seen.bodies[0] as (WireUpstreamBody & Record<string, unknown>) | undefined;
	if (first === undefined) {
		throw new Error("upstream was never called");
	}
	return first;
}

describe("gateway route wire contract", () => {
	it("answers successful turns as SSE with one frame per upstream payload", async () => {
		const { deps } = wireTurn({
			body: { messages: [{ content: "hello", role: "user" }], model: "wire-model" },
		});
		const response = await runGatewayTurn(deps);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		expect(await response.text()).toBe(
			`data: ${DELTA_CHUNK}\n\ndata: ${USAGE_CHUNK}\n\ndata: [DONE]\n\n`,
		);
	});

	it("always returns OpenAI error envelopes on rejection", async () => {
		const cases: Array<{ body: unknown; status: number }> = [
			{ body: { messages: "not-an-array", model: "wire-model" }, status: 400 },
			{ body: { messages: [], model: "wire-model" }, status: 400 },
			{
				body: { messages: [{ content: "hi", role: "user" }], model: "wire-model", stream: "yes" },
				status: 400,
			},
			{ body: { model: "wire-model" }, status: 400 },
		];
		for (const example of cases) {
			// biome-ignore lint/performance/noAwaitInLoops: sequential wire assertions keep failures attributable
			const response = await runGatewayTurn(wireTurn({ body: example.body }).deps);
			expect(response.status).toBe(example.status);
			const error = await errorOf(response);
			expect(typeof error.message).toBe("string");
			expect(typeof error.type).toBe("string");
			expect(typeof error.code).toBe("string");
		}
	});

	it("rejects the turn when no model is available anywhere", async () => {
		const { deps } = wireTurn({
			body: { messages: [{ content: "hi", role: "user" }] },
			defaultModel: undefined,
		});
		const withoutDefault: GatewayTurnDeps = {
			...deps,
			upstream: { ...deps.upstream, defaultModel: undefined },
		};
		const response = await runGatewayTurn(withoutDefault);
		expect(response.status).toBe(400);
		expect((await errorOf(response)).code).toBe("model_required");
	});

	it("concatenates new user content across turns for validation", async () => {
		const inspected: Interaction[] = [];
		const pipeline: ControlPipeline = {
			inspect: (interaction) => {
				inspected.push(interaction);
				return Promise.resolve({
					content: interaction.content,
					flagged: false,
					hits: [],
					redactions: [],
					verdict: "allow",
				});
			},
		};
		const { deps } = wireTurn({
			body: {
				messages: [
					{ content: "first", role: "user" },
					{ content: "thinking", role: "assistant" },
					{ content: "second", role: "user" },
				],
				model: "wire-model",
			},
			pipeline,
		});
		const response = await runGatewayTurn(deps);
		expect(response.status).toBe(200);
		expect(inspected).toHaveLength(1);
		expect(inspected[0]?.content).toBe("first\nsecond");
		expect(inspected[0]?.seam).toBe("llm-gateway");
		expect(inspected[0]?.model).toBe("wire-model");
	});

	it("reads text from content-part arrays", async () => {
		const inspected: Interaction[] = [];
		const pipeline: ControlPipeline = {
			inspect: (interaction) => {
				inspected.push(interaction);
				return Promise.resolve({
					content: interaction.content,
					flagged: false,
					hits: [],
					redactions: [],
					verdict: "allow",
				});
			},
		};
		const { deps } = wireTurn({
			body: {
				messages: [
					{
						content: [
							{ text: "look at this", type: "text" },
							{ [IMAGE_URL_KEY]: { url: "https://example.test/p.png" }, type: IMAGE_PART_TYPE },
						],
						role: "user",
					},
				],
				model: "wire-model",
			},
			pipeline,
		});
		const response = await runGatewayTurn(deps);
		expect(response.status).toBe(200);
		expect(inspected[0]?.content).toBe("look at this");
	});

	it("still streams SSE when the harness opts out of streaming", async () => {
		const { deps } = wireTurn({
			body: { messages: [{ content: "hi", role: "user" }], model: "wire-model", stream: false },
		});
		const response = await runGatewayTurn(deps);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		expect(await response.text()).toContain("[DONE]");
	});

	it("forces streaming and usage upstream", async () => {
		const { deps, seen } = wireTurn({
			body: { messages: [{ content: "hi", role: "user" }], model: "wire-model", stream: false },
		});
		const response = await runGatewayTurn(deps);
		expect(response.status).toBe(200);
		await response.text();
		const forwarded = upstreamBody(seen);
		expect(forwarded.model).toBe("wire-model");
		expect(forwarded.stream).toBe(true);
		expect(forwarded[STREAM_OPTIONS_KEY]).toEqual({ [INCLUDE_USAGE_KEY]: true });
	});

	it("ends the stream with an error payload when upstream aborts mid-flight", async () => {
		const encoder = new TextEncoder();
		const fetchImpl: FetchImpl = () =>
			Promise.resolve(
				new Response(
					new ReadableStream({
						pull(controller) {
							controller.error(new Error("connection reset"));
						},
						start(controller) {
							controller.enqueue(encoder.encode(`data: ${DELTA_CHUNK}\n\n`));
						},
					}),
					{ status: 200 },
				),
			);
		const store = new FakeGatewayStore();
		const { deps } = wireTurn({
			body: { messages: [{ content: "hi", role: "user" }], model: "wire-model" },
		});
		const response = await runGatewayTurn({ ...deps, fetchImpl, store });
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toContain(DELTA_CHUNK);
		expect(text).toContain("upstream-failure");
		expect(store.audits[0]?.cause).toBe("upstream-failure");
		expect(store.usages).toHaveLength(1);
	});
});
