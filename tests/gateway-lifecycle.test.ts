/**
 * Lifecycle tests for the LLM gateway turn (`runGatewayTurn`).
 *
 * Every test injects a fake {@link GatewayStore}, a stubbed fetch, and
 * fixture pipelines — no network, no credentials, no Jev calls. The focus
 * here is orchestration: stage order, audit/usage rows, budget math, and
 * upstream failure settlement.
 */

import { describe, expect, it } from "bun:test";
import type { Policy } from "#/control/policy/schema.ts";
import type { SemanticConfig } from "#/control/semantic/index.ts";
import { USER_GROUP_ID_HEADER, USER_ID_HEADER } from "#/control/subjects.ts";
import type { ControlPipeline, Interaction } from "#/control/types.ts";
import { type GatewayTurnDeps, type PriceForModel, runGatewayTurn } from "#/gateway/lifecycle.ts";
import type {
	GatewayAuditRow,
	GatewayStore,
	GatewayUsageRow,
	SpendSummary,
} from "#/gateway/store.ts";
import type { FetchImpl } from "#/gateway/upstream.ts";
import {
	blockOn,
	escalateOn,
	identityResolver,
	pipelineWith,
	redactOn,
} from "./helpers/fixtures.ts";

const NOW_SECONDS = 1_700_000_000;
const SECONDS_PER_DAY = 86_400;

const DELTA_CHUNK = `{"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}`;
const USAGE_CHUNK = `{"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":7,"total_tokens":12}}`;
const DONE_MARKER = "[DONE]";

class FakeGatewayStore implements GatewayStore {
	audits: (GatewayAuditRow & { id: number })[] = [];
	spend: SpendSummary = { costUsd: 0, tokens: 0, unpricedTokens: 0 };
	spendCalls: { since: number; userId: string }[] = [];
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

	spendSince(userId: string, since: number): SpendSummary {
		this.spendCalls.push({ since, userId });
		return this.spend;
	}
}

function semanticConfig(
	groups: Record<string, string[]> = { hr: [], manager: [] },
): SemanticConfig {
	return {
		checks: [],
		floors: { decisiveness: 0.9 },
		groups,
		maxChars: 4000,
		model: "fixture-judge",
		timeoutMs: 5000,
	};
}

function chatRequest(body: unknown, userId?: string, groupId?: string): Request {
	const headers = new Headers({ "content-type": "application/json" });
	if (userId !== undefined) {
		headers.set(USER_ID_HEADER, userId);
	}
	if (groupId !== undefined) {
		headers.set(USER_GROUP_ID_HEADER, groupId);
	}
	return new Request("http://test.local/v1/chat/completions", {
		body: JSON.stringify(body),
		headers,
		method: "POST",
	});
}

interface SeenUpstream {
	bodies: unknown[];
	inits: RequestInit[];
	urls: string[];
}

/** Canned SSE fetch double; records every upstream call for assertions. */
function stubFetch(payloads: string[], status = 200): { fetchImpl: FetchImpl; seen: SeenUpstream } {
	const seen: SeenUpstream = { bodies: [], inits: [], urls: [] };
	const fetchImpl: FetchImpl = (input, init) => {
		seen.urls.push(String(input));
		if (init !== undefined) {
			seen.inits.push(init);
		}
		if (init?.body !== undefined) {
			seen.bodies.push(JSON.parse(String(init.body)) as unknown);
		}
		return Promise.resolve(
			new Response(payloads.map((payload) => `data: ${payload}\n\n`).join(""), {
				headers: { "content-type": "text/event-stream" },
				status,
			}),
		);
	};
	return { fetchImpl, seen };
}

/** Default fetch double: fails loudly so tests never touch the network. */
const failingFetch: FetchImpl = () => Promise.reject(new Error("network is stubbed in tests"));

function upstreamBodies(seen: SeenUpstream): SeenUpstreamBody[] {
	return seen.bodies.map((body) => body as SeenUpstreamBody);
}

interface SeenUpstreamBody {
	messages: { content: unknown }[];
	model: unknown;
}

interface TurnInput {
	body?: unknown;
	clock?: () => number;
	defaultModel?: string | undefined;
	fetchImpl?: FetchImpl;
	groupId?: string;
	pipeline?: ControlPipeline;
	priceFor?: PriceForModel;
	rules?: Policy["controls"]["budget"]["rules"];
	semanticGroups?: Record<string, string[]>;
	store?: FakeGatewayStore;
	userId?: string;
}

function makeTurn(input: TurnInput = {}): { deps: GatewayTurnDeps; store: FakeGatewayStore } {
	const store = input.store ?? new FakeGatewayStore();
	const deps: GatewayTurnDeps = {
		clock: input.clock ?? (() => NOW_SECONDS),
		fetchImpl: input.fetchImpl ?? failingFetch,
		identity: identityResolver(),
		pipeline: input.pipeline ?? pipelineWith([]),
		policy: {
			budget: { overBudgetVerdict: "block", rules: input.rules ?? [] },
			policyVersion: "test-policy",
		},
		priceFor: input.priceFor ?? (() => null),
		request: chatRequest(
			input.body ?? { messages: [{ content: "hello", role: "user" }], model: "test-model" },
			input.userId ?? "alice",
			input.groupId ?? "hr",
		),
		semanticConfig: semanticConfig(input.semanticGroups),
		store,
		upstream: {
			apiKey: "test-key",
			baseUrl: "https://upstream.test",
			defaultModel: input.defaultModel ?? "test-model",
		},
	};
	return { deps, store };
}

function spyingPipeline(): { calls: Interaction[]; pipeline: ControlPipeline } {
	const calls: Interaction[] = [];
	const pipeline: ControlPipeline = {
		inspect: (interaction) => {
			calls.push(interaction);
			return Promise.resolve({
				content: interaction.content,
				flagged: false,
				hits: [],
				redactions: [],
				verdict: "allow",
			});
		},
	};
	return { calls, pipeline };
}

interface OpenAiErrorBody {
	error: { code: string; message: string; type: string };
}

async function errorOf(response: Response): Promise<OpenAiErrorBody["error"]> {
	return ((await response.json()) as OpenAiErrorBody).error;
}

describe("gateway lifecycle identity", () => {
	it("rejects missing identity with 401 and records missing-identity", async () => {
		const { deps, store } = makeTurn();
		const response = await runGatewayTurn({
			...deps,
			request: chatRequest({ messages: [{ content: "hi", role: "user" }], model: "m" }),
		});
		expect(response.status).toBe(401);
		expect((await errorOf(response)).code).toBe("missing-identity");
		expect(store.audits).toHaveLength(1);
		expect(store.audits[0]?.cause).toBe("missing-identity");
		expect(store.audits[0]?.verdict).toBe("block");
		expect(store.usages).toHaveLength(0);
	});

	it("rejects an unknown group with 403 and records unknown-group", async () => {
		const { deps, store } = makeTurn({ groupId: "ghost-group", userId: "ghost" });
		const response = await runGatewayTurn(deps);
		expect(response.status).toBe(403);
		expect((await errorOf(response)).code).toBe("unknown-group");
		expect(store.audits).toHaveLength(1);
		expect(store.audits[0]?.cause).toBe("unknown-group");
		expect(store.audits[0]?.controlId).toBe("caller-identity");
	});

	it("rejects groups missing from the semantic config without falling back", async () => {
		const { deps, store } = makeTurn({
			groupId: "solo",
			semanticGroups: { hr: [], manager: [] },
			userId: "solo-user",
		});
		const withSoloIdentity: GatewayTurnDeps = {
			...deps,
			identity: identityResolver({ knownGroups: ["hr", "manager", "solo"] }),
		};
		const response = await runGatewayTurn(withSoloIdentity);
		expect(response.status).toBe(403);
		expect((await errorOf(response)).code).toBe("unknown-group");
		expect(store.audits[0]?.controlId).toBe("semantic-checks");
	});
});

describe("gateway lifecycle budget precheck", () => {
	const dayRule: Policy["controls"]["budget"]["rules"][number] = {
		key: "alice",
		modelScope: "*",
		period: "day",
		tokens: 10,
	};

	it("rejects over-budget callers with 429 before any control runs", async () => {
		const spy = spyingPipeline();
		const store = new FakeGatewayStore();
		store.spend = { costUsd: 0, tokens: 1000, unpricedTokens: 0 };
		const { fetchImpl, seen } = stubFetch([DELTA_CHUNK, USAGE_CHUNK, DONE_MARKER]);
		const { deps } = makeTurn({ fetchImpl, pipeline: spy.pipeline, rules: [dayRule], store });
		const response = await runGatewayTurn(deps);
		expect(response.status).toBe(429);
		expect((await errorOf(response)).code).toBe("budget-exhausted");
		expect(spy.calls).toHaveLength(0);
		expect(seen.urls).toHaveLength(0);
		expect(store.audits).toHaveLength(1);
		expect(store.audits[0]?.cause).toBe("budget-exhausted");
		expect(store.usages).toHaveLength(0);
	});

	it("checks spend against the rule window", async () => {
		const store = new FakeGatewayStore();
		const { fetchImpl } = stubFetch([DELTA_CHUNK, USAGE_CHUNK, DONE_MARKER]);
		const { deps } = makeTurn({ fetchImpl, rules: [dayRule], store });
		await runGatewayTurn(deps);
		expect(store.spendCalls).toHaveLength(1);
		expect(store.spendCalls[0]?.userId).toBe("alice");
		expect(store.spendCalls[0]?.since).toBe(NOW_SECONDS - SECONDS_PER_DAY);
	});

	it("ignores other users and other model scopes", async () => {
		const store = new FakeGatewayStore();
		store.spend = { costUsd: 0, tokens: 1000, unpricedTokens: 0 };
		const { fetchImpl } = stubFetch([DELTA_CHUNK, USAGE_CHUNK, DONE_MARKER]);
		const otherUserRule: Policy["controls"]["budget"]["rules"][number] = {
			key: "bob",
			modelScope: "*",
			period: "day",
			tokens: 10,
		};
		const scopedRule: Policy["controls"]["budget"]["rules"][number] = {
			key: "alice",
			modelScope: "other-model",
			period: "day",
			tokens: 10,
		};
		const { deps } = makeTurn({ fetchImpl, rules: [otherUserRule, scopedRule], store });
		const response = await runGatewayTurn(deps);
		expect(response.status).toBe(200);
	});
});

describe("gateway lifecycle validation", () => {
	it("rejects malformed bodies with 400 before any control runs", async () => {
		const spy = spyingPipeline();
		const { deps, store } = makeTurn({
			body: { messages: [], model: "test-model" },
			pipeline: spy.pipeline,
		});
		const response = await runGatewayTurn(deps);
		expect(response.status).toBe(400);
		expect((await errorOf(response)).type).toBe("invalid_request_error");
		expect(spy.calls).toHaveLength(0);
		expect(store.audits).toHaveLength(1);
		expect(store.audits[0]?.controlId).toBe("request-shape");
	});

	it("blocks gated content with 403 naming the control and stores the prompt", async () => {
		const { fetchImpl, seen } = stubFetch([DELTA_CHUNK, USAGE_CHUNK, DONE_MARKER]);
		const { deps, store } = makeTurn({
			body: { messages: [{ content: "please BLOCKME now", role: "user" }], model: "test-model" },
			fetchImpl,
			pipeline: pipelineWith([blockOn("BLOCKME")]),
		});
		const response = await runGatewayTurn(deps);
		expect(response.status).toBe(403);
		const error = await errorOf(response);
		expect(error.code).toBe("fixture-block");
		expect(error.message).toContain("fixture-block");
		expect(seen.urls).toHaveLength(0);
		expect(store.audits).toHaveLength(1);
		expect(store.audits[0]?.cause).toBe("blocked-by-check");
		expect(store.audits[0]?.promptText).toBe("please BLOCKME now");
		expect(store.audits[0]?.verdict).toBe("block");
		expect(store.usages).toHaveLength(0);
	});

	it("escalates without forwarding the content", async () => {
		const { fetchImpl, seen } = stubFetch([DELTA_CHUNK, USAGE_CHUNK, DONE_MARKER]);
		const { deps } = makeTurn({
			body: { messages: [{ content: "HOLD for review", role: "user" }], model: "test-model" },
			fetchImpl,
			pipeline: pipelineWith([escalateOn("HOLD")]),
		});
		const response = await runGatewayTurn(deps);
		expect(response.status).toBe(403);
		const error = await errorOf(response);
		expect(error.code).toBe("fixture-escalate");
		expect(error.message).toContain("escalated");
		expect(seen.urls).toHaveLength(0);
	});

	it("inspects only user messages, never assistant history", async () => {
		const { fetchImpl, seen } = stubFetch([DELTA_CHUNK, USAGE_CHUNK, DONE_MARKER]);
		const { deps } = makeTurn({
			body: {
				messages: [
					{ content: "hello", role: "user" },
					{ content: "BLOCKME inside history", role: "assistant" },
					{ content: "world", role: "user" },
				],
				model: "test-model",
			},
			fetchImpl,
			pipeline: pipelineWith([blockOn("BLOCKME")]),
		});
		const response = await runGatewayTurn(deps);
		expect(response.status).toBe(200);
		expect(seen.urls).toHaveLength(1);
	});

	it("forwards redacted text when the verdict is redact", async () => {
		const { fetchImpl, seen } = stubFetch([DELTA_CHUNK, USAGE_CHUNK, DONE_MARKER]);
		const { deps, store } = makeTurn({
			body: { messages: [{ content: "token SECRET-1 stays", role: "user" }], model: "test-model" },
			fetchImpl,
			pipeline: pipelineWith([redactOn("SECRET-1", "[TOKEN]")]),
		});
		const response = await runGatewayTurn(deps);
		expect(response.status).toBe(200);
		await response.text();
		const forwarded = upstreamBodies(seen)[0]?.messages;
		expect(forwarded?.[0]?.content).toBe("token [TOKEN] stays");
		expect(store.audits).toHaveLength(1);
		expect(store.audits[0]?.verdict).toBe("redact");
		expect(store.audits[0]?.promptText).toBeNull();
	});
});

describe("gateway lifecycle forwarding and settlement", () => {
	it("streams upstream chunks verbatim and settles allow plus usage", async () => {
		const { fetchImpl, seen } = stubFetch([DELTA_CHUNK, USAGE_CHUNK, DONE_MARKER]);
		const { deps, store } = makeTurn({ fetchImpl });
		const response = await runGatewayTurn(deps);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		expect(await response.text()).toBe(
			`data: ${DELTA_CHUNK}\n\ndata: ${USAGE_CHUNK}\n\ndata: ${DONE_MARKER}\n\n`,
		);
		expect(seen.urls).toEqual(["https://upstream.test/v1/chat/completions"]);
		expect(store.audits).toHaveLength(1);
		expect(store.audits[0]?.cause).toBeNull();
		expect(store.audits[0]?.controlId).toBe("pipeline");
		expect(store.audits[0]?.promptText).toBeNull();
		expect(store.audits[0]?.verdict).toBe("allow");
		expect(store.usages).toHaveLength(1);
		expect(store.usages[0]?.promptTokens).toBe(5);
		expect(store.usages[0]?.completionTokens).toBe(7);
		expect(store.usages[0]?.model).toBe("test-model");
		expect(store.usages[0]?.userId).toBe("alice");
		expect(store.usages[0]?.groupId).toBe("hr");
		expect(store.usages[0]?.costUsd).toBeNull();
		expect(store.usages[0]?.auditEventId).toBe(store.audits[0]?.id);
	});

	it("computes cost for priced models", async () => {
		const { fetchImpl } = stubFetch([DELTA_CHUNK, USAGE_CHUNK, DONE_MARKER]);
		const { deps, store } = makeTurn({
			fetchImpl,
			priceFor: () => ({ inputPerToken: 0.5, outputPerToken: 0.5 }),
		});
		const response = await runGatewayTurn(deps);
		expect(response.status).toBe(200);
		await response.text();
		expect(store.usages[0]?.costUsd).toBe(6);
	});

	it("forwards the client-requested model, else the default", async () => {
		const { fetchImpl, seen } = stubFetch([DELTA_CHUNK, USAGE_CHUNK, DONE_MARKER]);
		const requested = makeTurn({
			body: { messages: [{ content: "hi", role: "user" }], model: "custom-model" },
			fetchImpl,
		});
		const requestedResponse = await runGatewayTurn(requested.deps);
		expect(requestedResponse.status).toBe(200);
		await requestedResponse.text();
		expect(upstreamBodies(seen)[0]?.model).toBe("custom-model");
		expect(requested.store.usages[0]?.model).toBe("custom-model");

		const fallback = makeTurn({
			body: { messages: [{ content: "hi", role: "user" }] },
			defaultModel: "fallback-model",
			fetchImpl,
		});
		const fallbackResponse = await runGatewayTurn(fallback.deps);
		expect(fallbackResponse.status).toBe(200);
		await fallbackResponse.text();
		expect(upstreamBodies(seen)[1]?.model).toBe("fallback-model");
	});

	it("maps non-2xx upstream to a 502 with an upstream-failure audit and no usage", async () => {
		const { fetchImpl } = stubFetch(["provider exploded"], 500);
		const { deps, store } = makeTurn({ fetchImpl });
		const response = await runGatewayTurn(deps);
		expect(response.status).toBe(502);
		const error = await errorOf(response);
		expect(error.code).toBe("upstream-failure");
		expect(store.audits).toHaveLength(1);
		expect(store.audits[0]?.cause).toBe("upstream-failure");
		expect(store.usages).toHaveLength(0);
	});

	it("records partial usage when the stream aborts mid-flight", async () => {
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
		const { deps, store } = makeTurn({ fetchImpl });
		const response = await runGatewayTurn(deps);
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toContain(DELTA_CHUNK);
		expect(text).toContain("upstream-failure");
		expect(store.audits).toHaveLength(1);
		expect(store.audits[0]?.cause).toBe("upstream-failure");
		expect(store.usages).toHaveLength(1);
		expect(store.usages[0]?.promptTokens).toBe(0);
		expect(store.usages[0]?.auditEventId).toBe(store.audits[0]?.id);
	});
});
