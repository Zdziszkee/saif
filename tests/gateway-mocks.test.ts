import { describe, expect, it, mock } from "bun:test";
import { handleGuardRequest } from "#/control/guard-api.ts";
import { createControlPipeline } from "#/control/pipeline.ts";
import { createSemanticControl } from "#/control/semantic/control.ts";
import { createFixedClassifier } from "#/control/semantic/double.ts";
import type { Control, ControlResult, Interaction } from "#/control/types.ts";
import { type GatewayDeps, handleChatCompletions } from "#/gateway/gateway.ts";
import type { FetchLike } from "#/gateway/openai.ts";
import { costForModel, parsePriceTable } from "#/gateway/prices.ts";
import { type BudgetRule, UsageLedger } from "#/gateway/usage.ts";
import { auditSink, identityResolver } from "./helpers/fixtures.ts";
import { makeCheck } from "./semantic/helpers.ts";

function userHeaders(userId = "alice", groupId = "hr"): Headers {
	return new Headers({
		"content-type": "application/json",
		"x-user-group-id": groupId,
		"x-user-id": userId,
	});
}

function chatBody(messages: unknown[], model = "m", stream = false): Request {
	return new Request("http://test.local/v1/chat/completions", {
		body: JSON.stringify({ messages, model, stream }),
		headers: userHeaders(),
		method: "POST",
	});
}

function gatewayDeps(overrides: Partial<GatewayDeps> = {}): GatewayDeps {
	return {
		audit: auditSink(),
		identity: identityResolver(),
		ledger: new UsageLedger(),
		pipeline: createControlPipeline({ controls: [] }),
		policyBudgetRules: [],
		prices: async () => null,
		upstream: { apiKey: "test-key", baseUrl: "https://upstream.invalid" },
		...overrides,
	};
}

function mockUpstream(body: unknown, status = 200): FetchLike {
	return async () =>
		new Response(JSON.stringify(body), {
			headers: { "content-type": "application/json" },
			status,
		});
}

function mockControl(
	id: string,
	result: ControlResult,
): Control & { inspect: ReturnType<typeof mock> } {
	const inspect = mock((_interaction: Interaction): ControlResult => result);
	return { id, inspect };
}

const ALLOW = { verdict: "allow" } as const;

describe("mocked pipeline verdicts through the gateway", () => {
	it("1. forwards untouched content on allow", async () => {
		let forwarded: unknown = null;
		const deps = gatewayDeps({
			fetchImpl: ((url, init) => {
				forwarded = JSON.parse(String(init?.body));
				return mockUpstream({ choices: [] })(url, init);
			}) as FetchLike,
		});
		const response = await handleChatCompletions(
			chatBody([{ content: "hello", role: "user" }]),
			deps,
		);
		expect(response.status).toBe(200);
		expect(forwarded).toMatchObject({ messages: [{ content: "hello", role: "user" }] });
		expect(forwarded).not.toHaveProperty("stream_options");
	});

	it("2. never calls semantic after a deterministic block", async () => {
		const semantic = mockControl("semantic", ALLOW);
		const blocker = mockControl("deterministic", {
			hit: { controlId: "deterministic", kind: "injection", verdict: "block" },
			verdict: "block",
		});
		const deps = gatewayDeps({
			fetchImpl: () => Promise.reject(new Error("must not forward")),
			pipeline: createControlPipeline({ controls: [blocker, semantic] }),
		});
		const response = await handleChatCompletions(
			chatBody([{ content: "payload", role: "user" }]),
			deps,
		);
		expect(response.status).toBe(403);
		expect(semantic.inspect).toHaveBeenCalledTimes(0);
		expect(blocker.inspect).toHaveBeenCalledTimes(1);
	});

	it("3. rebuilds redacted parts before forwarding", async () => {
		let forwarded: unknown = null;
		const redactor = mockControl("deterministic", {
			hit: { controlId: "deterministic", kind: "pii", verdict: "redact" },
			redactions: [
				{ detectorId: "email", end: 5, kind: "pii.email", placeholder: "[E]", start: 0 },
			],
			verdict: "redact",
		});
		const deps = gatewayDeps({
			fetchImpl: ((url, init) => {
				forwarded = JSON.parse(String(init?.body));
				return mockUpstream({ choices: [] })(url, init);
			}) as FetchLike,
			pipeline: createControlPipeline({ controls: [redactor] }),
		});
		const response = await handleChatCompletions(
			chatBody([{ content: "a@b.cd here", role: "user" }]),
			deps,
		);
		expect(response.status).toBe(200);
		expect(forwarded).toMatchObject({ messages: [{ content: "[E]d here", role: "user" }] });
	});

	it("4. forwards flagged parts and notes the count", async () => {
		const flagger = mockControl("deterministic", {
			hit: { controlId: "deterministic", kind: "custom", verdict: "flag" },
			verdict: "allow",
		});
		const audit = auditSink();
		const deps = gatewayDeps({
			audit,
			fetchImpl: mockUpstream({ choices: [] }),
			pipeline: createControlPipeline({ controls: [flagger] }),
		});
		const response = await handleChatCompletions(
			chatBody([{ content: "maybe", role: "user" }]),
			deps,
		);
		expect(response.status).toBe(200);
		expect(audit.events.some((event) => event.detail?.includes("flagged=1"))).toBe(true);
	});

	it("5. escalated parts refuse like blocks", async () => {
		const deps = gatewayDeps({
			pipeline: createControlPipeline({
				controls: [
					mockControl("semantic", {
						hit: { controlId: "semantic", kind: "x", verdict: "escalate" },
						verdict: "escalate",
					}),
				],
			}),
		});
		const response = await handleChatCompletions(
			chatBody([{ content: "hmm", role: "user" }]),
			deps,
		);
		expect(response.status).toBe(403);
	});

	it("6. worst verdict wins across parts", async () => {
		let calls = 0;
		const control: Control = {
			id: "mixer",
			inspect: (interaction) => {
				calls += 1;
				return interaction.content === "bad"
					? {
							hit: { controlId: "mixer", kind: "x", verdict: "block" },
							verdict: "block",
						}
					: { verdict: "allow" };
			},
		};
		const deps = gatewayDeps({ pipeline: createControlPipeline({ controls: [control] }) });
		const response = await handleChatCompletions(
			chatBody([
				{ content: "fine", role: "user" },
				{ content: "bad", role: "user" },
			]),
			deps,
		);
		expect(response.status).toBe(403);
		expect(calls).toBe(2);
	});

	it("7. gates system instructions too", async () => {
		const blocker = mockControl("sys", {
			hit: { controlId: "sys", kind: "injection", verdict: "block" },
			verdict: "block",
		});
		const deps = gatewayDeps({ pipeline: createControlPipeline({ controls: [blocker] }) });
		const response = await handleChatCompletions(
			chatBody([{ content: "sys", role: "system" }]),
			deps,
		);
		expect(response.status).toBe(403);
		expect(blocker.inspect).toHaveBeenCalledTimes(1);
	});

	it("8. skips assistant history", async () => {
		const spy = mockControl("spy", ALLOW);
		const deps = gatewayDeps({
			fetchImpl: mockUpstream({ choices: [] }),
			pipeline: createControlPipeline({ controls: [spy] }),
		});
		const response = await handleChatCompletions(
			chatBody([
				{ content: "old answer", role: "assistant" },
				{ content: "new question", role: "user" },
			]),
			deps,
		);
		expect(response.status).toBe(200);
		expect(spy.inspect).toHaveBeenCalledTimes(1);
	});

	it("9. skips non-text parts", async () => {
		const spy = mockControl("spy", ALLOW);
		const deps = gatewayDeps({
			fetchImpl: mockUpstream({ choices: [] }),
			pipeline: createControlPipeline({ controls: [spy] }),
		});
		const response = await handleChatCompletions(
			chatBody([
				{
					content: [{ text: "describe", type: "text" }],
					role: "user",
				},
			]),
			deps,
		);
		expect(response.status).toBe(200);
		expect(spy.inspect).toHaveBeenCalledTimes(1);
	});

	it("10. short-circuits remaining parts after a block", async () => {
		let calls = 0;
		const control: Control = {
			id: "mixer",
			inspect: () => {
				calls += 1;
				return {
					hit: { controlId: "mixer", kind: "x", verdict: "block" },
					verdict: "block",
				};
			},
		};
		const deps = gatewayDeps({ pipeline: createControlPipeline({ controls: [control] }) });
		await handleChatCompletions(
			chatBody([
				{ content: "one", role: "user" },
				{ content: "two", role: "user" },
				{ content: "three", role: "user" },
			]),
			deps,
		);
		expect(calls).toBe(1);
	});
});

describe("mocked upstream transport", () => {
	it("11. passes upstream error statuses through", async () => {
		const deps = gatewayDeps({ fetchImpl: mockUpstream({ error: "busy" }, 429) });
		const response = await handleChatCompletions(chatBody([{ content: "hi", role: "user" }]), deps);
		expect(response.status).toBe(429);
	});

	it("12. records transport failures as upstream-failure", async () => {
		const audit = auditSink();
		const deps = gatewayDeps({
			audit,
			fetchImpl: () => Promise.reject(new Error("down")),
		});
		const response = await handleChatCompletions(chatBody([{ content: "hi", role: "user" }]), deps);
		expect(response.status).toBe(502);
		expect(audit.events.some((event) => event.controlId === "upstream")).toBe(true);
	});

	it("13. rejects null streamed bodies", async () => {
		const deps = gatewayDeps({
			fetchImpl: (async () => new Response(null, { status: 200 })) as FetchLike,
		});
		const response = await handleChatCompletions(
			chatBody([{ content: "hi", role: "user" }], "m", true),
			deps,
		);
		expect(response.status).toBe(502);
	});

	it("14. rejects invalid upstream JSON", async () => {
		const deps = gatewayDeps({
			fetchImpl: (async () => new Response("not json", { status: 200 })) as FetchLike,
		});
		const response = await handleChatCompletions(chatBody([{ content: "hi", role: "user" }]), deps);
		expect(response.status).toBe(502);
	});

	it("15. records zero usage when upstream omits it", async () => {
		const ledger = new UsageLedger();
		const deps = gatewayDeps({
			fetchImpl: mockUpstream({ choices: [] }),
			ledger,
		});
		const response = await handleChatCompletions(chatBody([{ content: "hi", role: "user" }]), deps);
		expect(response.status).toBe(200);
		expect(ledger.snapshot()).toHaveLength(1);
		expect(ledger.snapshot()[0]).toMatchObject({ completionTokens: 0, promptTokens: 0 });
	});

	it("16. forwards the client authorization header", async () => {
		const seen: { auth: string | null } = { auth: null };
		const deps = gatewayDeps({
			fetchImpl: ((url, init) => {
				seen.auth = new Headers(init?.headers).get("authorization");
				return mockUpstream({ choices: [] })(url, init);
			}) as FetchLike,
		});
		const request = new Request("http://test.local/v1/chat/completions", {
			body: JSON.stringify({ messages: [{ content: "hi", role: "user" }], model: "m" }),
			headers: new Headers({
				authorization: "Bearer client-key",
				"content-type": "application/json",
				"x-user-group-id": "hr",
				"x-user-id": "alice",
			}),
			method: "POST",
		});
		await handleChatCompletions(request, deps);
		expect(seen.auth).toBe("Bearer client-key");
	});

	it("17. falls back to the configured upstream key", async () => {
		const seen: { auth: string | null } = { auth: null };
		const deps = gatewayDeps({
			fetchImpl: ((url, init) => {
				seen.auth = new Headers(init?.headers).get("authorization");
				return mockUpstream({ choices: [] })(url, init);
			}) as FetchLike,
			upstream: { apiKey: "env-key", baseUrl: "https://upstream.invalid" },
		});
		await handleChatCompletions(chatBody([{ content: "hi", role: "user" }]), deps);
		expect(seen.auth).toBe("Bearer env-key");
	});

	it("18. sends no auth header when no key exists anywhere", async () => {
		const seen: { auth: string | null } = { auth: null };
		const deps = gatewayDeps({
			fetchImpl: ((url, init) => {
				seen.auth = new Headers(init?.headers).get("authorization");
				return mockUpstream({ choices: [] })(url, init);
			}) as FetchLike,
			upstream: { baseUrl: "https://upstream.invalid" },
		});
		await handleChatCompletions(chatBody([{ content: "hi", role: "user" }]), deps);
		expect(seen.auth).toBeNull();
	});

	it("19. posts to the upstream chat-completions URL", async () => {
		let url = "";
		const deps = gatewayDeps({
			fetchImpl: ((input) => {
				url = String(input);
				return mockUpstream({ choices: [] })(input);
			}) as FetchLike,
			upstream: { baseUrl: "https://upstream.invalid/" },
		});
		await handleChatCompletions(chatBody([{ content: "hi", role: "user" }]), deps);
		expect(url).toBe("https://upstream.invalid/chat/completions");
	});

	it("20. forwards the requested model verbatim", async () => {
		let forwarded: unknown = null;
		const deps = gatewayDeps({
			fetchImpl: ((url, init) => {
				forwarded = JSON.parse(String(init?.body));
				return mockUpstream({ choices: [] })(url, init);
			}) as FetchLike,
		});
		await handleChatCompletions(chatBody([{ content: "hi", role: "user" }], "weird-model"), deps);
		expect(forwarded).toMatchObject({ model: "weird-model" });
	});

	it("21. merges stream usage options only for streams", async () => {
		const bodies: unknown[] = [];
		const deps = gatewayDeps({
			fetchImpl: ((url, init) => {
				bodies.push(JSON.parse(String(init?.body)));
				return mockUpstream({ choices: [] })(url, init);
			}) as FetchLike,
		});
		await handleChatCompletions(chatBody([{ content: "hi", role: "user" }], "m", false), deps);
		await handleChatCompletions(chatBody([{ content: "hi", role: "user" }], "m", true), deps);
		expect(bodies[0]).not.toHaveProperty("stream_options");
		expect(bodies[1]).toMatchObject({ stream_options: { include_usage: true } });
	});
});

describe("mocked budgets", () => {
	const rule: BudgetRule = { key: "alice", modelScope: "*", period: "day", tokens: 10 };

	function spentLedger(tokens: number): UsageLedger {
		const ledger = new UsageLedger();
		ledger.record({
			at: new Date().toISOString(),
			completionTokens: 0,
			costUsd: null,
			groupId: "hr",
			model: "m",
			promptTokens: tokens,
			userId: "alice",
		});
		return ledger;
	}

	it("22. blocks token exhaustion", async () => {
		const deps = gatewayDeps({ ledger: spentLedger(10), policyBudgetRules: [rule] });
		const response = await handleChatCompletions(chatBody([{ content: "hi", role: "user" }]), deps);
		expect(response.status).toBe(403);
	});

	it("23. allows under-limit spend", async () => {
		const deps = gatewayDeps({
			fetchImpl: mockUpstream({ choices: [] }),
			ledger: spentLedger(5),
			policyBudgetRules: [rule],
		});
		const response = await handleChatCompletions(chatBody([{ content: "hi", role: "user" }]), deps);
		expect(response.status).toBe(200);
	});

	it("24. enforces hourly windows", async () => {
		const ledger = new UsageLedger();
		ledger.record({
			at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
			completionTokens: 0,
			costUsd: null,
			groupId: "hr",
			model: "m",
			promptTokens: 99,
			userId: "alice",
		});
		const deps = gatewayDeps({
			fetchImpl: mockUpstream({ choices: [] }),
			ledger,
			policyBudgetRules: [{ ...rule, period: "hour" }],
		});
		const response = await handleChatCompletions(chatBody([{ content: "hi", role: "user" }]), deps);
		expect(response.status).toBe(200);
	});

	it("25. enforces monthly windows", async () => {
		const ledger = new UsageLedger();
		ledger.record({
			at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
			completionTokens: 0,
			costUsd: null,
			groupId: "hr",
			model: "m",
			promptTokens: 99,
			userId: "alice",
		});
		const deps = gatewayDeps({
			fetchImpl: mockUpstream({ choices: [] }),
			ledger,
			policyBudgetRules: [{ ...rule, period: "month" }],
		});
		const response = await handleChatCompletions(chatBody([{ content: "hi", role: "user" }]), deps);
		expect(response.status).toBe(200);
	});

	it("26. skips rules for other models", async () => {
		const deps = gatewayDeps({
			fetchImpl: mockUpstream({ choices: [] }),
			ledger: spentLedger(50),
			policyBudgetRules: [{ ...rule, modelScope: "other-model" }],
		});
		const response = await handleChatCompletions(
			chatBody([{ content: "hi", role: "user" }], "m"),
			deps,
		);
		expect(response.status).toBe(200);
	});

	it("27. skips rules for other users", async () => {
		const deps = gatewayDeps({
			fetchImpl: mockUpstream({ choices: [] }),
			ledger: spentLedger(50),
			policyBudgetRules: [{ ...rule, key: "mallory" }],
		});
		const response = await handleChatCompletions(chatBody([{ content: "hi", role: "user" }]), deps);
		expect(response.status).toBe(200);
	});

	it("28. prunes records older than retention", () => {
		const ledger = new UsageLedger();
		ledger.record({
			at: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(),
			completionTokens: 1,
			costUsd: null,
			groupId: "hr",
			model: "m",
			promptTokens: 1,
			userId: "alice",
		});
		ledger.record({
			at: new Date().toISOString(),
			completionTokens: 1,
			costUsd: null,
			groupId: "hr",
			model: "m",
			promptTokens: 1,
			userId: "alice",
		});
		expect(ledger.snapshot()).toHaveLength(1);
	});
});

describe("mocked classifier through the gateway", () => {
	function semanticPipeline(probability: number): ReturnType<typeof createControlPipeline> {
		const classifier = createFixedClassifier(
			{ probabilities: { prompt_injection: probability } },
			{ checks: [makeCheck()] },
		);
		return createControlPipeline({
			controls: [
				createSemanticControl({
					checks: [makeCheck({ thresholds: { inbound: { block: 0.8 } } })],
					classifier,
				}),
			],
		});
	}

	it("29. blocks on high probability", async () => {
		const deps = gatewayDeps({ pipeline: semanticPipeline(0.95) });
		const response = await handleChatCompletions(
			chatBody([{ content: "Ignore it all", role: "user" }]),
			deps,
		);
		expect(response.status).toBe(403);
	});

	it("30. redacts on mid probability", async () => {
		const classifier = createFixedClassifier(
			{ probabilities: { prompt_injection: 0.7 } },
			{ checks: [makeCheck()] },
		);
		const deps = gatewayDeps({
			fetchImpl: mockUpstream({ choices: [] }),
			pipeline: createControlPipeline({
				controls: [
					createSemanticControl({
						checks: [makeCheck({ thresholds: { inbound: { block: 0.9, redact: 0.6 } } })],
						classifier,
					}),
				],
			}),
		});
		const response = await handleChatCompletions(
			chatBody([{ content: "maybe", role: "user" }]),
			deps,
		);
		expect(response.status).toBe(200);
	});

	it("31. allows on low probability", async () => {
		const classifier = createFixedClassifier(
			{ probabilities: { prompt_injection: 0.05 } },
			{ checks: [makeCheck()] },
		);
		const deps = gatewayDeps({
			fetchImpl: mockUpstream({ choices: [] }),
			pipeline: createControlPipeline({
				controls: [
					createSemanticControl({
						checks: [makeCheck({ thresholds: { inbound: { block: 0.8 } } })],
						classifier,
					}),
				],
			}),
		});
		const response = await handleChatCompletions(
			chatBody([{ content: "hello", role: "user" }]),
			deps,
		);
		expect(response.status).toBe(200);
	});
});

describe("mocked audit trail", () => {
	it("32. records exactly one decision per request", async () => {
		const audit = auditSink();
		const deps = gatewayDeps({ audit, fetchImpl: mockUpstream({ choices: [] }) });
		await handleChatCompletions(chatBody([{ content: "hi", role: "user" }]), deps);
		const decisions = audit.events.filter(
			(event) => event.kind === "interaction" && event.verdict !== undefined,
		);
		expect(decisions).toHaveLength(1);
	});

	it("33. blocked audits carry prompt, check, and no upstream call", async () => {
		let upstreamCalls = 0;
		const audit = auditSink();
		const deps = gatewayDeps({
			audit,
			fetchImpl: () => {
				upstreamCalls += 1;
				return Promise.reject(new Error("must not forward"));
			},
			pipeline: createControlPipeline({
				controls: [
					mockControl("sig", {
						hit: { controlId: "sig", kind: "jailbreak", verdict: "block" },
						verdict: "block",
					}),
				],
			}),
		});
		await handleChatCompletions(chatBody([{ content: "secret plans here", role: "user" }]), deps);
		expect(upstreamCalls).toBe(0);
		const blocked = audit.events.find((event) => event.detail?.includes("blocked-by-check"));
		expect(blocked?.detail).toContain("secret plans here");
		expect(blocked?.detail).toContain("sig");
	});

	it("34. allowed audits exclude prompt content", async () => {
		const audit = auditSink();
		const deps = gatewayDeps({ audit, fetchImpl: mockUpstream({ choices: [] }) });
		await handleChatCompletions(chatBody([{ content: "sensitive but fine", role: "user" }]), deps);
		const allowed = audit.events.find((event) => event.verdict === "allow");
		expect(allowed?.detail).not.toContain("sensitive but fine");
	});

	it("35. usage rows carry user, group, and model", async () => {
		const ledger = new UsageLedger();
		const deps = gatewayDeps({
			fetchImpl: mockUpstream({ choices: [], usage: { completion_tokens: 2, prompt_tokens: 3 } }),
			ledger,
		});
		await handleChatCompletions(chatBody([{ content: "hi", role: "user" }], "demo"), deps);
		expect(ledger.snapshot()).toHaveLength(1);
		expect(ledger.snapshot()[0]).toMatchObject({ groupId: "hr", model: "demo", userId: "alice" });
	});

	it("36. unpriced models record null cost", async () => {
		const ledger = new UsageLedger();
		const deps = gatewayDeps({
			fetchImpl: mockUpstream({ choices: [], usage: { completion_tokens: 2, prompt_tokens: 3 } }),
			ledger,
			prices: async () => ({}),
		});
		await handleChatCompletions(chatBody([{ content: "hi", role: "user" }], "ghost"), deps);
		expect(ledger.snapshot()[0]?.costUsd).toBeNull();
	});
});

describe("mocked prices", () => {
	it("37. rejects negative prices", () => {
		expect(
			costForModel(
				parsePriceTable({ m: { input_cost_per_token: -1, output_cost_per_token: 0 } }),
				"m",
				1,
				1,
			),
		).toBeNull();
	});

	it("38. computes zero-cost models", () => {
		expect(
			costForModel(
				parsePriceTable({ free: { input_cost_per_token: 0, output_cost_per_token: 0 } }),
				"free",
				100,
				100,
			),
		).toBe(0);
	});

	it("39. rejects non-object documents", () => {
		expect(parsePriceTable([1, 2, 3])).toEqual({});
		expect(parsePriceTable(null)).toEqual({});
	});
});

describe("mocked pipeline edges", () => {
	it("40. times out hanging controls", async () => {
		const hanging: Control = {
			id: "hang",
			inspect: () => new Promise<never>(() => undefined),
		};
		const pipeline = createControlPipeline({ controls: [hanging], timeoutMs: 20 });
		const outcome = await pipeline.inspect({
			content: "hi",
			direction: "inbound",
			groupId: "hr",
			id: "t",
			seam: "chat",
			userId: "alice",
		});
		expect(outcome.verdict).toBe("block");
	});

	it("41. fails closed on unusable verdicts", async () => {
		const broken = mockControl("broken", { verdict: "nope" } as unknown as ControlResult);
		const pipeline = createControlPipeline({ controls: [broken] });
		const outcome = await pipeline.inspect({
			content: "hi",
			direction: "inbound",
			groupId: "hr",
			id: "t",
			seam: "chat",
			userId: "alice",
		});
		expect(outcome.verdict).toBe("block");
	});

	it("42. fails closed on out-of-bounds spans", async () => {
		const sloppy = mockControl("sloppy", {
			redactions: [{ detectorId: "x", end: 9999, kind: "x", placeholder: "[X]", start: 0 }],
			verdict: "redact",
		});
		const pipeline = createControlPipeline({ controls: [sloppy] });
		const outcome = await pipeline.inspect({
			content: "hi",
			direction: "inbound",
			groupId: "hr",
			id: "t",
			seam: "chat",
			userId: "alice",
		});
		expect(outcome.verdict).toBe("block");
	});

	it("43. merges flags from two controls", async () => {
		const first = mockControl("one", {
			hit: { controlId: "one", kind: "a", verdict: "flag" },
			verdict: "allow",
		});
		const second = mockControl("two", {
			hit: { controlId: "two", kind: "b", verdict: "flag" },
			verdict: "allow",
		});
		const pipeline = createControlPipeline({ controls: [first, second] });
		const outcome = await pipeline.inspect({
			content: "hi",
			direction: "inbound",
			groupId: "hr",
			id: "t",
			seam: "chat",
			userId: "alice",
		});
		expect(outcome.verdict).toBe("allow");
	});

	it("44. attributes first block on ties", async () => {
		const first = mockControl("one", {
			hit: { controlId: "one", kind: "a", verdict: "block" },
			verdict: "block",
		});
		const second = mockControl("two", {
			hit: { controlId: "two", kind: "b", verdict: "block" },
			verdict: "block",
		});
		const pipeline = createControlPipeline({ controls: [first, second] });
		const outcome = await pipeline.inspect({
			content: "hi",
			direction: "inbound",
			groupId: "hr",
			id: "t",
			seam: "chat",
			userId: "alice",
		});
		expect(outcome.blockingControl).toBe("one");
	});

	it("45. escalate outranks redact", async () => {
		const pipeline = createControlPipeline({
			controls: [
				mockControl("redactor", {
					hit: { controlId: "redactor", kind: "a", verdict: "redact" },
					redactions: [],
					verdict: "redact",
				}),
				mockControl("escalator", {
					hit: { controlId: "escalator", kind: "b", verdict: "escalate" },
					verdict: "escalate",
				}),
			],
		});
		const outcome = await pipeline.inspect({
			content: "hi",
			direction: "inbound",
			groupId: "hr",
			id: "t",
			seam: "chat",
			userId: "alice",
		});
		expect(outcome.verdict).toBe("escalate");
	});

	it("46. keeps earlier block when a later control fails", async () => {
		const blocker = mockControl("blocker", {
			hit: { controlId: "blocker", kind: "a", verdict: "block" },
			verdict: "block",
		});
		const failing: Control = {
			id: "failing",
			inspect: () => {
				throw new Error("boom");
			},
		};
		const pipeline = createControlPipeline({ controls: [blocker, failing] });
		const outcome = await pipeline.inspect({
			content: "hi",
			direction: "inbound",
			groupId: "hr",
			id: "t",
			seam: "chat",
			userId: "alice",
		});
		expect(outcome.verdict).toBe("block");
		expect(outcome.blockingControl).toBe("blocker");
	});

	it("47. records audit failures", async () => {
		const audit = auditSink();
		const failing: Control = {
			id: "failing",
			inspect: () => {
				throw new Error("boom");
			},
		};
		const pipeline = createControlPipeline({ audit, controls: [failing] });
		await pipeline.inspect({
			content: "hi",
			direction: "inbound",
			groupId: "hr",
			id: "t",
			seam: "chat",
			userId: "alice",
		});
		expect(audit.events.some((event) => event.kind === "failure")).toBe(true);
	});

	it("48. malformed guard requests never reach controls", async () => {
		const spy = mockControl("spy", ALLOW);
		const response = await handleGuardRequest(
			new Request("http://test.local/api/guard", {
				body: JSON.stringify({ nope: true }),
				headers: userHeaders(),
				method: "POST",
			}),
			{
				identity: identityResolver(),
				pipeline: createControlPipeline({ controls: [spy] }),
			},
		);
		expect(response.status).toBe(400);
		expect(spy.inspect).toHaveBeenCalledTimes(0);
	});

	it("49. rejects unauthenticated guard requests", async () => {
		const spy = mockControl("spy", ALLOW);
		const response = await handleGuardRequest(
			new Request("http://test.local/api/guard", {
				body: JSON.stringify({ content: "hi", direction: "inbound", seam: "chat" }),
				headers: new Headers({ "content-type": "application/json" }),
				method: "POST",
			}),
			{
				identity: identityResolver(),
				pipeline: createControlPipeline({ controls: [spy] }),
			},
		);
		expect(response.status).toBe(403);
		expect(spy.inspect).toHaveBeenCalledTimes(0);
	});

	it("50. rejects unknown groups on guard requests", async () => {
		const spy = mockControl("spy", ALLOW);
		const response = await handleGuardRequest(
			new Request("http://test.local/api/guard", {
				body: JSON.stringify({ content: "hi", direction: "inbound", seam: "chat" }),
				headers: new Headers({
					"content-type": "application/json",
					"x-user-group-id": "ghost-group",
					"x-user-id": "ghost",
				}),
				method: "POST",
			}),
			{
				identity: identityResolver(),
				pipeline: createControlPipeline({ controls: [spy] }),
			},
		);
		expect(response.status).toBe(403);
		expect(spy.inspect).toHaveBeenCalledTimes(0);
	});
});
