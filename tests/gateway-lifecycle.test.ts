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
	failingControl,
	identityResolver,
	pipelineWith,
	redactOn,
} from "./helpers/fixtures.ts";

const NOW_SECONDS = 1_700_000_000;
const SECONDS_PER_DAY = 86_400;

const DELTA_CHUNK = `{"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}`;
const USAGE_CHUNK = `{"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":7,"total_tokens":12}}`;
const DONE_MARKER = "[DONE]";
const SCORED_DETAIL = "prompt_injection=0.91, jailbreak=0.87";
const SCORED_KIND = "prompt_injection";
const SCORED_SCORE = 0.91;
const CLASSIFIER_FAILURE_MESSAGE = "classifier exploded";
const CLASSIFIER_CONTROL_ID = "fixture-failure";
const SIGNATURE_KIND = "signature-match";
const SIGNATURE_DETAIL = "signature example-pattern";
const SEMANTIC_EVIDENCE_KIND = "prompt-injection";
const SEMANTIC_EVIDENCE_DETAIL = "prompt_injection=0.87";
const SEMANTIC_EVIDENCE_SCORE = 0.87;
const ALLOW_FIRST_KIND = "allow-first";
const ALLOW_FIRST_DETAIL = "allow first detail";
const ALLOW_SECOND_DETAIL = "allow second detail";
const ALLOW_SECOND_SCORE = 0.42;
const EVIDENCE_PROMPT = "hello";
const EVIDENCE_SEPARATOR = "; ";

function captureStdout(): { lines: string[]; restore: () => void } {
	const lines: string[] = [];
	const original = process.stdout.write.bind(process.stdout);
	const replacement = ((chunk: unknown) => {
		lines.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	process.stdout.write = replacement;
	return {
		lines,
		restore: () => {
			process.stdout.write = original;
		},
	};
}

function scoredBlockPipeline(): ControlPipeline {
	return {
		inspect: () =>
			Promise.resolve({
				blockingControl: "semantic-checks",
				content: "newest evil",
				flagged: false,
				hits: [
					{
						controlId: "semantic",
						detail: SCORED_DETAIL,
						kind: SCORED_KIND,
						score: SCORED_SCORE,
						verdict: "block",
					},
				],
				redactions: [],
				verdict: "block",
			}),
	};
}

function scoredAllowPipeline(): ControlPipeline {
	return {
		inspect: (interaction) =>
			Promise.resolve({
				blockingControl: undefined,
				content: interaction.content,
				flagged: true,
				hits: [
					{
						controlId: "semantic",
						detail: SCORED_DETAIL,
						kind: SCORED_KIND,
						score: SCORED_SCORE,
						verdict: "flag",
					},
				],
				redactions: [],
				verdict: "allow",
			}),
	};
}

function signatureThenSemanticBlockPipeline(): ControlPipeline {
	return {
		inspect: () =>
			Promise.resolve({
				blockingControl: "pipeline",
				content: EVIDENCE_PROMPT,
				flagged: false,
				hits: [
					{
						controlId: "signature",
						detail: SIGNATURE_DETAIL,
						kind: SIGNATURE_KIND,
						verdict: "block",
					},
					{
						controlId: "semantic",
						detail: SEMANTIC_EVIDENCE_DETAIL,
						kind: SEMANTIC_EVIDENCE_KIND,
						score: SEMANTIC_EVIDENCE_SCORE,
						verdict: "block",
					},
				],
				redactions: [],
				verdict: "block",
			}),
	};
}

function twoAllowHitsPipeline(): ControlPipeline {
	return {
		inspect: (interaction) =>
			Promise.resolve({
				blockingControl: undefined,
				content: interaction.content,
				flagged: false,
				hits: [
					{
						controlId: "allow-first",
						detail: ALLOW_FIRST_DETAIL,
						kind: ALLOW_FIRST_KIND,
						verdict: "allow",
					},
					{
						controlId: "allow-second",
						detail: ALLOW_SECOND_DETAIL,
						kind: "allow-second",
						score: ALLOW_SECOND_SCORE,
						verdict: "allow",
					},
				],
				redactions: [],
				verdict: "allow",
			}),
	};
}

function emptyDetailBlockPipeline(): ControlPipeline {
	return {
		inspect: () =>
			Promise.resolve({
				blockingControl: "pipeline",
				content: EVIDENCE_PROMPT,
				flagged: false,
				hits: [
					{ controlId: "empty-first", kind: "empty-first", verdict: "block" },
					{ controlId: "empty-second", detail: "   ", kind: "empty-second", verdict: "block" },
				],
				redactions: [],
				verdict: "block",
			}),
	};
}

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

	it("ignores history length when reserving budget for the newest turn", async () => {
		const { fetchImpl } = stubFetch([DELTA_CHUNK, USAGE_CHUNK, DONE_MARKER]);
		const { deps, store } = makeTurn({
			body: {
				messages: [
					{ content: "x".repeat(200), role: "user" },
					{ content: "thinking", role: "assistant" },
					{ content: "hi", role: "user" },
				],
				model: "test-model",
			},
			fetchImpl,
			rules: [dayRule],
		});
		const response = await runGatewayTurn(deps);
		expect(response.status).toBe(200);
		await response.text();
		expect(store.audits).toHaveLength(1);
		expect(store.audits[0]?.verdict).toBe("allow");
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

	it("inspects only the newest user turn, never assistant history", async () => {
		const spy = spyingPipeline();
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
			pipeline: spy.pipeline,
		});
		const response = await runGatewayTurn(deps);
		expect(response.status).toBe(200);
		expect(seen.urls).toHaveLength(1);
		expect(spy.calls).toHaveLength(1);
		expect(spy.calls[0]?.content).toBe("world");
	});

	it("isolates blocked history from the clean active turn", async () => {
		const { fetchImpl } = stubFetch([DELTA_CHUNK, USAGE_CHUNK, DONE_MARKER]);
		const { deps, store } = makeTurn({
			body: {
				messages: [
					{ content: "BLOCKME in old history", role: "user" },
					{ content: "thinking", role: "assistant" },
					{ content: "clean hello", role: "user" },
				],
				model: "test-model",
			},
			fetchImpl,
			pipeline: pipelineWith([blockOn("BLOCKME")]),
		});
		const response = await runGatewayTurn(deps);
		expect(response.status).toBe(200);
		await response.text();
		expect(store.audits).toHaveLength(1);
		expect(store.audits[0]?.verdict).toBe("allow");
		expect(store.audits[0]?.promptText).toBeNull();
	});

	it("stores only the newest turn text for blocked rows with check evidence", async () => {
		const { fetchImpl, seen } = stubFetch([DELTA_CHUNK, USAGE_CHUNK, DONE_MARKER]);
		const { deps, store } = makeTurn({
			body: {
				messages: [
					{ content: "hello history", role: "user" },
					{ content: "thinking", role: "assistant" },
					{ content: "please BLOCKME now", role: "user" },
				],
				model: "test-model",
			},
			fetchImpl,
			pipeline: pipelineWith([blockOn("BLOCKME")]),
		});
		const response = await runGatewayTurn(deps);
		expect(response.status).toBe(403);
		expect(seen.urls).toHaveLength(0);
		expect(store.audits).toHaveLength(1);
		expect(store.audits[0]?.promptText).toBe("please BLOCKME now");
		expect(store.audits[0]?.controlId).toBe("fixture");
		expect(store.audits[0]?.detail).toBe("marker BLOCKME");
		expect(store.audits[0]?.score).toBeNull();
	});

	it("records scored semantic evidence for blocked turns", async () => {
		const { fetchImpl } = stubFetch([DELTA_CHUNK, USAGE_CHUNK, DONE_MARKER]);
		const { deps, store } = makeTurn({
			body: { messages: [{ content: "evil newest", role: "user" }], model: "test-model" },
			fetchImpl,
			pipeline: scoredBlockPipeline(),
		});
		const response = await runGatewayTurn(deps);
		expect(response.status).toBe(403);
		expect(store.audits).toHaveLength(1);
		expect(store.audits[0]?.controlId).toBe(SCORED_KIND);
		expect(store.audits[0]?.score).toBe(SCORED_SCORE);
		expect(store.audits[0]?.detail).toBe(SCORED_DETAIL);
		expect(store.audits[0]?.promptText).toBe("evil newest");
	});

	it("preserves classifier failure text with a null score", async () => {
		const { fetchImpl, seen } = stubFetch([DELTA_CHUNK, USAGE_CHUNK, DONE_MARKER]);
		const { deps, store } = makeTurn({
			body: {
				messages: [
					{ content: "old history", role: "user" },
					{ content: "thinking", role: "assistant" },
					{ content: "clean newest", role: "user" },
				],
				model: "test-model",
			},
			fetchImpl,
			pipeline: pipelineWith([failingControl(CLASSIFIER_FAILURE_MESSAGE)]),
		});
		const response = await runGatewayTurn(deps);
		expect(response.status).toBe(403);
		expect(seen.urls).toHaveLength(0);
		expect(store.audits).toHaveLength(1);
		expect(store.audits[0]?.cause).toBe("classifier-failure");
		expect(store.audits[0]?.controlId).toBe(CLASSIFIER_CONTROL_ID);
		expect(store.audits[0]?.detail).toBe(CLASSIFIER_FAILURE_MESSAGE);
		expect(store.audits[0]?.score).toBeNull();
		expect(store.audits[0]?.promptText).toBe("clean newest");
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
		expect(store.audits[0]?.controlId).toBe("fixture");
		expect(store.audits[0]?.score).toBeNull();
	});

	it("maps redaction onto the retained original message index", async () => {
		const { fetchImpl, seen } = stubFetch([DELTA_CHUNK, USAGE_CHUNK, DONE_MARKER]);
		const { deps, store } = makeTurn({
			body: {
				messages: [
					{ content: "first history", role: "user" },
					{ content: "thinking", role: "assistant" },
					{ content: "token SECRET-1 stays", role: "user" },
				],
				model: "test-model",
			},
			fetchImpl,
			pipeline: pipelineWith([redactOn("SECRET-1", "[TOKEN]")]),
		});
		const response = await runGatewayTurn(deps);
		expect(response.status).toBe(200);
		await response.text();
		const forwarded = upstreamBodies(seen)[0]?.messages;
		expect(forwarded?.[0]?.content).toBe("first history");
		expect(forwarded?.[1]?.content).toBe("thinking");
		expect(forwarded?.[2]?.content).toBe("token [TOKEN] stays");
		expect(store.audits[0]?.verdict).toBe("redact");
		expect(store.audits[0]?.promptText).toBeNull();
	});

	it("retains scored evidence for allowed turns without storing content", async () => {
		const { fetchImpl } = stubFetch([DELTA_CHUNK, USAGE_CHUNK, DONE_MARKER]);
		const { deps, store } = makeTurn({
			body: { messages: [{ content: "hello newest", role: "user" }], model: "test-model" },
			fetchImpl,
			pipeline: scoredAllowPipeline(),
		});
		const response = await runGatewayTurn(deps);
		expect(response.status).toBe(200);
		await response.text();
		expect(store.audits).toHaveLength(1);
		expect(store.audits[0]?.verdict).toBe("allow");
		expect(store.audits[0]?.promptText).toBeNull();
		expect(store.audits[0]?.controlId).toBe(SCORED_KIND);
		expect(store.audits[0]?.score).toBe(SCORED_SCORE);
		expect(store.audits[0]?.detail).toBe(SCORED_DETAIL);
	});
});

describe("gateway lifecycle audit evidence", () => {
	it("combines signature and semantic blocked hits in order", async () => {
		const { fetchImpl } = stubFetch([DELTA_CHUNK, USAGE_CHUNK, DONE_MARKER]);
		const { deps, store } = makeTurn({
			body: { messages: [{ content: EVIDENCE_PROMPT, role: "user" }], model: "test-model" },
			fetchImpl,
			pipeline: signatureThenSemanticBlockPipeline(),
		});
		const response = await runGatewayTurn(deps);
		expect(response.status).toBe(403);
		expect(store.audits).toHaveLength(1);
		expect(store.audits[0]?.controlId).toBe(SIGNATURE_KIND);
		expect(store.audits[0]?.score).toBe(SEMANTIC_EVIDENCE_SCORE);
		expect(store.audits[0]?.detail).toBe(
			`${SIGNATURE_DETAIL}${EVIDENCE_SEPARATOR}${SEMANTIC_EVIDENCE_DETAIL}`,
		);
	});

	it("retains combined detail and score for settled allowed turns", async () => {
		const { fetchImpl } = stubFetch([DELTA_CHUNK, USAGE_CHUNK, DONE_MARKER]);
		const { deps, store } = makeTurn({
			body: { messages: [{ content: EVIDENCE_PROMPT, role: "user" }], model: "test-model" },
			fetchImpl,
			pipeline: twoAllowHitsPipeline(),
		});
		const response = await runGatewayTurn(deps);
		expect(response.status).toBe(200);
		await response.text();
		expect(store.audits).toHaveLength(1);
		expect(store.audits[0]?.verdict).toBe("allow");
		expect(store.audits[0]?.promptText).toBeNull();
		expect(store.audits[0]?.controlId).toBe(ALLOW_FIRST_KIND);
		expect(store.audits[0]?.score).toBe(ALLOW_SECOND_SCORE);
		expect(store.audits[0]?.detail).toBe(
			`${ALLOW_FIRST_DETAIL}${EVIDENCE_SEPARATOR}${ALLOW_SECOND_DETAIL}`,
		);
	});

	it("stores null when blocked details are missing or blank", async () => {
		const { fetchImpl } = stubFetch([DELTA_CHUNK, USAGE_CHUNK, DONE_MARKER]);
		const { deps, store } = makeTurn({
			body: { messages: [{ content: EVIDENCE_PROMPT, role: "user" }], model: "test-model" },
			fetchImpl,
			pipeline: emptyDetailBlockPipeline(),
		});
		const response = await runGatewayTurn(deps);
		expect(response.status).toBe(403);
		expect(store.audits).toHaveLength(1);
		expect(store.audits[0]?.detail).toBeNull();
		expect(store.audits[0]?.score).toBeNull();
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

describe("gateway lifecycle decision lines", () => {
	it("emits one line for blocked turns with identity, control, hits, and detail", async () => {
		const { fetchImpl } = stubFetch([DELTA_CHUNK, USAGE_CHUNK, DONE_MARKER]);
		const { deps } = makeTurn({
			body: { messages: [{ content: "evil newest", role: "user" }], model: "test-model" },
			fetchImpl,
			pipeline: scoredBlockPipeline(),
		});
		const captured = captureStdout();
		try {
			const response = await runGatewayTurn(deps);
			expect(response.status).toBe(403);
		} finally {
			captured.restore();
		}
		expect(captured.lines).toHaveLength(1);
		const line = captured.lines[0] ?? "";
		expect(line).toContain("user=alice");
		expect(line).toContain("group=hr");
		expect(line).toContain("dir=inbound");
		expect(line).toContain("model=test-model");
		expect(line).toContain("outcome=block");
		expect(line).toContain("blocking=semantic-checks");
		expect(line).toContain(SCORED_KIND);
		expect(line).toContain("score=0.91");
		expect(line).toContain(SCORED_DETAIL);
		expect(line).toContain("upstream=");
		expect(line).not.toContain("evil newest");
		expect(line.endsWith("\n")).toBe(true);
	});

	it("emits classifier failure detail on its own stdout line", async () => {
		const { fetchImpl } = stubFetch([DELTA_CHUNK, USAGE_CHUNK, DONE_MARKER]);
		const { deps } = makeTurn({
			body: { messages: [{ content: "clean newest", role: "user" }], model: "test-model" },
			fetchImpl,
			pipeline: pipelineWith([failingControl(CLASSIFIER_FAILURE_MESSAGE)]),
		});
		const captured = captureStdout();
		try {
			const response = await runGatewayTurn(deps);
			expect(response.status).toBe(403);
		} finally {
			captured.restore();
		}
		expect(captured.lines).toHaveLength(1);
		const line = captured.lines[0] ?? "";
		expect(line).toContain("outcome=block");
		expect(line).toContain(CLASSIFIER_FAILURE_MESSAGE);
		expect(line).not.toContain("clean newest");
		expect(line.endsWith("\n")).toBe(true);
	});

	it("emits one line for successful settlement with tokens, cost, and upstream ok", async () => {
		const { fetchImpl } = stubFetch([DELTA_CHUNK, USAGE_CHUNK, DONE_MARKER]);
		const { deps } = makeTurn({
			body: { messages: [{ content: "hello newest", role: "user" }], model: "test-model" },
			fetchImpl,
			pipeline: scoredAllowPipeline(),
			priceFor: () => ({ inputPerToken: 0.5, outputPerToken: 0.5 }),
		});
		const captured = captureStdout();
		try {
			const response = await runGatewayTurn(deps);
			expect(response.status).toBe(200);
			await response.text();
		} finally {
			captured.restore();
		}
		expect(captured.lines).toHaveLength(1);
		const line = captured.lines[0] ?? "";
		expect(line).toContain("user=alice");
		expect(line).toContain("outcome=allow");
		expect(line).toContain("model=test-model");
		expect(line).toContain("tokens=");
		expect(line).toContain("cost=");
		expect(line).toContain("upstream=ok");
		expect(line).toContain("status=200");
		expect(line).toContain(SCORED_DETAIL);
		expect(line).toContain("score=0.91");
		expect(line).not.toContain("hello newest");
		expect(line.endsWith("\n")).toBe(true);
	});

	it("emits one line each for malformed, budget, and upstream failures", async () => {
		const malformed = makeTurn({ body: { messages: [], model: "test-model" } });
		const malformedCaptured = captureStdout();
		try {
			const response = await runGatewayTurn(malformed.deps);
			expect(response.status).toBe(400);
		} finally {
			malformedCaptured.restore();
		}
		expect(malformedCaptured.lines).toHaveLength(1);
		expect(malformedCaptured.lines[0]).toContain("outcome=block");
		expect(malformedCaptured.lines[0]).toContain("blocking=request-shape");

		const dayRule: Policy["controls"]["budget"]["rules"][number] = {
			key: "alice",
			modelScope: "*",
			period: "day",
			tokens: 10,
		};
		const budgetStore = new FakeGatewayStore();
		budgetStore.spend = { costUsd: 0, tokens: 1000, unpricedTokens: 0 };
		const budget = makeTurn({
			fetchImpl: stubFetch([DELTA_CHUNK, USAGE_CHUNK, DONE_MARKER]).fetchImpl,
			rules: [dayRule],
			store: budgetStore,
		});
		const budgetCaptured = captureStdout();
		try {
			const response = await runGatewayTurn(budget.deps);
			expect(response.status).toBe(429);
		} finally {
			budgetCaptured.restore();
		}
		expect(budgetCaptured.lines).toHaveLength(1);
		expect(budgetCaptured.lines[0]).toContain("blocking=budget");
		expect(budgetCaptured.lines[0]).toContain("budget-exhausted");

		const upstream = makeTurn({ fetchImpl: stubFetch(["boom"], 500).fetchImpl });
		const upstreamCaptured = captureStdout();
		try {
			const response = await runGatewayTurn(upstream.deps);
			expect(response.status).toBe(502);
		} finally {
			upstreamCaptured.restore();
		}
		expect(upstreamCaptured.lines).toHaveLength(1);
		expect(upstreamCaptured.lines[0]).toContain("upstream=upstream-failure");
	});
});

describe("gateway audit fan-out", () => {
	it("invokes onAudit with the settled row after the store write", async () => {
		const { fetchImpl } = stubFetch([DELTA_CHUNK, USAGE_CHUNK, DONE_MARKER]);
		const { pipeline } = spyingPipeline();
		const seen: GatewayAuditRow[] = [];
		const { deps, store } = makeTurn({ fetchImpl, pipeline });
		const response = await runGatewayTurn({
			...deps,
			onAudit: (row) => {
				seen.push(row);
			},
		});
		expect(response.status).toBe(200);
		await response.text();
		expect(store.audits).toHaveLength(1);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.verdict).toBe("allow");
		expect(seen[0]?.userId).toBe("alice");
		expect(seen[0]?.groupId).toBe("hr");
		expect(seen[0]?.policyVersion).toBe("test-policy");
	});

	it("still records the store row when no hook is attached", async () => {
		const { fetchImpl } = stubFetch([DELTA_CHUNK, USAGE_CHUNK, DONE_MARKER]);
		const { pipeline } = spyingPipeline();
		const { deps, store } = makeTurn({ fetchImpl, pipeline });
		const response = await runGatewayTurn(deps);
		expect(response.status).toBe(200);
		await response.text();
		expect(store.audits).toHaveLength(1);
	});
});
