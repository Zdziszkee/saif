// biome-ignore-all lint/style/useNamingConvention: OpenAI wire-format keys are snake_case by specification.
import { describe, expect, it } from "bun:test";
import type { AuditSink } from "#/control/audit.ts";
import { createPriceTable } from "#/control/pricing.ts";
import { MAX_CONTENT_LENGTH } from "#/control/shape.ts";
import { USER_GROUP_ID_HEADER, USER_ID_HEADER } from "#/control/subjects.ts";
import type { ControlPipeline, Interaction } from "#/control/types.ts";
import {
	type ChatCompletionsGatewayDeps,
	createWindowedUsageTracker,
	type GatewayUsageRow,
	handleChatCompletions,
	type UsageCheckResult,
} from "#/routes/api.chat-completions.ts";
import {
	auditSink,
	blockOn,
	identityResolver,
	pipelineWith,
	redactOn,
	type TestAudit,
} from "./helpers/fixtures.ts";

interface CompletionBody {
	choices: Array<{ message: { content: string } }>;
	usage: { completion_tokens: number; prompt_tokens: number; total_tokens: number };
}

interface ErrorBody {
	control?: string;
	details?: string[];
	error?: string;
	reason?: string;
	verdict?: string;
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

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		messages: [{ content: "hello", role: "user" }],
		model: "test-model",
		...overrides,
	};
}

interface UpstreamReply {
	completionTokens?: number;
	promptTokens?: number;
	text: string;
}

function upstreamJson(
	reply: UpstreamReply,
	seenBodies: unknown[],
	seenUrls: string[] = [],
): typeof fetch {
	return ((url: unknown, init?: RequestInit) => {
		seenUrls.push(String(url));
		seenBodies.push(JSON.parse(String(init?.body)));
		const completionTokens = reply.completionTokens ?? 7;
		const promptTokens = reply.promptTokens ?? 5;
		return Promise.resolve(
			Response.json({
				choices: [
					{
						finish_reason: "stop",
						index: 0,
						message: { content: reply.text, role: "assistant" },
					},
				],
				created: 1,
				id: "chatcmpl-upstream",
				model: "test-model",
				object: "chat.completion",
				usage: {
					completion_tokens: completionTokens,
					prompt_tokens: promptTokens,
					total_tokens: completionTokens + promptTokens,
				},
			}),
		);
	}) as unknown as typeof fetch;
}

function upstreamStream(chunks: string[], seenBodies: unknown[]): typeof fetch {
	return ((_url: unknown, init?: RequestInit) => {
		seenBodies.push(JSON.parse(String(init?.body)));
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) {
					controller.enqueue(new TextEncoder().encode(chunk));
				}
				controller.close();
			},
		});
		return Promise.resolve(
			new Response(stream, { headers: { "content-type": "text/event-stream" } }),
		);
	}) as unknown as typeof fetch;
}

interface GatewayHarness {
	audit: TestAudit;
	deps: ChatCompletionsGatewayDeps;
	inspected: Interaction[];
	upstreamBodies: unknown[];
	usageRows: GatewayUsageRow[];
}

function harness(
	overrides: Partial<ChatCompletionsGatewayDeps> = {},
	upstreamText = "upstream answer",
): GatewayHarness {
	const audit = auditSink();
	const inspected: Interaction[] = [];
	const upstreamBodies: unknown[] = [];
	const usageRows: GatewayUsageRow[] = [];
	const base: ControlPipeline = overrides.pipeline ?? pipelineWith([]);
	const deps: ChatCompletionsGatewayDeps = {
		audit,
		baseUrl: "https://model.test",
		identity: identityResolver(),
		modelName: "test-model",
		onUsage: (row) => {
			usageRows.push(row);
		},
		upstreamFetch: upstreamJson({ text: upstreamText }, upstreamBodies),
		...overrides,
		pipeline: {
			inspect: (interaction) => {
				inspected.push(interaction);
				return base.inspect(interaction);
			},
		},
	};
	return { audit, deps, inspected, upstreamBodies, usageRows };
}

function pricedTable(): ReturnType<typeof createPriceTable> {
	const document = {
		"test-model": { input_cost_per_token: 0.000_001, output_cost_per_token: 0.000_002 },
	};
	return createPriceTable({
		fetch: (async () => Response.json(document)) as unknown as typeof fetch,
	});
}

function scopeDetail(audit: AuditSink, groupId: string): string | undefined {
	if (!("events" in audit)) {
		return;
	}
	const { events }: { events?: unknown } = audit;
	if (!Array.isArray(events)) {
		return;
	}
	const scoped = events.find(
		(event): event is { controlId?: string; detail?: string } =>
			typeof event === "object" &&
			event !== null &&
			(event as { controlId?: string }).controlId === "semantic-scope" &&
			((event as { groupId?: string }).groupId as string | undefined) === groupId,
	);
	return scoped?.detail;
}

describe("chat-completions gateway", () => {
	it("answers a valid completion and settles a priced usage row", async () => {
		const seen = harness({ priceTable: pricedTable() });
		const response = await handleChatCompletions(
			chatRequest(validBody(), "alice", "hr"),
			seen.deps,
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as CompletionBody;
		expect(body.choices[0]?.message.content).toBe("upstream answer");
		expect(body.usage).toEqual({ completion_tokens: 7, prompt_tokens: 5, total_tokens: 12 });

		expect(seen.usageRows).toHaveLength(1);
		const row = seen.usageRows[0];
		expect(row).toMatchObject({
			completionTokens: 7,
			groupId: "hr",
			model: "test-model",
			promptTokens: 5,
			totalTokens: 12,
			userId: "alice",
		});
		expect(row?.costUsd).toBeCloseTo(5 * 0.000_001 + 7 * 0.000_002);
		expect(
			seen.audit.events.some(
				(event) => event.kind === "budget" && event.controlId === "usage-accounting",
			),
		).toBe(true);

		const upstream = seen.upstreamBodies[0] as {
			messages: Array<{ content: string }>;
			model: string;
		};
		expect(upstream.model).toBe("test-model");
		expect(upstream.messages[0]?.content).toBe("hello");
	});

	it("rejects malformed requests before any control evaluation", async () => {
		const seen = harness();
		const response = await handleChatCompletions(
			chatRequest({ model: "test-model" }, "alice", "hr"),
			seen.deps,
		);
		expect(response.status).toBe(400);
		const body = (await response.json()) as ErrorBody;
		expect(body.error).toBe("malformed_request");
		expect(body.details?.length).toBeGreaterThan(0);
		expect(seen.inspected).toHaveLength(0);
		expect(seen.upstreamBodies).toHaveLength(0);
		expect(
			seen.audit.events.some((event) => event.detail?.includes("malformed request rejected")),
		).toBe(true);
	});

	it("rejects oversized content before any control evaluation", async () => {
		const seen = harness();
		const response = await handleChatCompletions(
			chatRequest(
				validBody({ messages: [{ content: "x".repeat(MAX_CONTENT_LENGTH + 1), role: "user" }] }),
				"alice",
				"hr",
			),
			seen.deps,
		);
		expect(response.status).toBe(400);
		const body = (await response.json()) as ErrorBody;
		expect(body.error).toBe("malformed_request");
		expect(seen.inspected).toHaveLength(0);
		expect(seen.upstreamBodies).toHaveLength(0);
	});

	it("rejects a missing identity with zero control evaluation", async () => {
		const seen = harness();
		const response = await handleChatCompletions(chatRequest(validBody()), seen.deps);
		expect(response.status).toBe(403);
		const body = (await response.json()) as ErrorBody;
		expect(body.control).toBe("caller-identity");
		expect(body.error).toBe("rejected");
		expect(seen.inspected).toHaveLength(0);
		expect(seen.upstreamBodies).toHaveLength(0);
	});

	it("rejects an unknown group and records the cause", async () => {
		const seen = harness();
		const response = await handleChatCompletions(
			chatRequest(validBody(), "ghost", "ghost-group"),
			seen.deps,
		);
		expect(response.status).toBe(403);
		const body = (await response.json()) as ErrorBody;
		expect(body.control).toBe("caller-identity");
		expect(body.reason).toContain("ghost-group");
		expect(
			seen.audit.events.some(
				(event) =>
					event.controlId === "caller-identity" &&
					event.detail?.includes("user group not defined by policy"),
			),
		).toBe(true);
		expect(seen.inspected).toHaveLength(0);
	});

	it("short-circuits over-limit callers before any tier runs", async () => {
		const seen = harness({
			usageLimit: {
				checkUsage: (): Promise<UsageCheckResult> =>
					Promise.resolve({ ok: false, reason: "quota spent" }),
			},
		});
		const response = await handleChatCompletions(
			chatRequest(validBody(), "alice", "hr"),
			seen.deps,
		);
		expect(response.status).toBe(429);
		const body = (await response.json()) as ErrorBody;
		expect(body.control).toBe("usage-limit");
		expect(body.error).toBe("over_limit");
		expect(seen.inspected).toHaveLength(0);
		expect(seen.upstreamBodies).toHaveLength(0);
		expect(
			seen.audit.events.some(
				(event) =>
					event.kind === "budget" && event.controlId === "usage-limit" && event.verdict === "block",
			),
		).toBe(true);
	});

	it("resolves different semantic question sets per group for the same content", async () => {
		const seen = harness({
			semanticChecksForGroup: (groupId) =>
				groupId === "hr" ? ["q-hr-a", "q-hr-b"] : ["q-manager"],
		});
		for (const groupId of ["hr", "manager"]) {
			// biome-ignore lint/performance/noAwaitInLoops: groups run in order so audit scopes stay comparable
			const response = await handleChatCompletions(
				chatRequest(validBody(), "caller", groupId),
				seen.deps,
			);
			expect(response.status).toBe(200);
		}
		const hrScope = scopeDetail(seen.audit, "hr");
		const managerScope = scopeDetail(seen.audit, "manager");
		expect(hrScope).toContain("q-hr-a");
		expect(hrScope).toContain("q-hr-b");
		expect(managerScope).toContain("q-manager");
		expect(hrScope).not.toEqual(managerScope);
	});

	it("defaults to the existing semantic group mapping", async () => {
		const seen = harness();
		const response = await handleChatCompletions(
			chatRequest(validBody(), "alice", "hr"),
			seen.deps,
		);
		expect(response.status).toBe(200);
		const detail = scopeDetail(seen.audit, "hr") ?? "";
		expect(detail).toContain("prompt_injection");
		expect(detail).toContain("data_exfiltration");
	});

	it("relays SSE chunks through unchanged, in order, without answer inspection", async () => {
		const chunks = ['data: {"token":"one"}\n\n', 'data: {"token":"two"}\n\n', "data: [DONE]\n\n"];
		const upstreamBodies: unknown[] = [];
		const inspected: Interaction[] = [];
		const base = pipelineWith([]);
		const audit = auditSink();
		const deps: ChatCompletionsGatewayDeps = {
			audit,
			baseUrl: "https://model.test",
			identity: identityResolver(),
			modelName: "test-model",
			pipeline: {
				inspect: (interaction) => {
					inspected.push(interaction);
					return base.inspect(interaction);
				},
			},
			upstreamFetch: upstreamStream(chunks, upstreamBodies),
		};
		const response = await handleChatCompletions(
			chatRequest(validBody({ stream: true }), "alice", "hr"),
			deps,
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		expect(await response.text()).toBe(chunks.join(""));
		// One inbound inspection for the single prompt message; the streamed
		// answer is never inspected (that would require buffering it).
		expect(inspected).toHaveLength(1);
		expect(inspected[0]?.direction).toBe("inbound");
		const upstream = upstreamBodies[0] as { messages: unknown[]; stream: boolean };
		expect(upstream.stream).toBe(true);
		expect(upstream.messages).toHaveLength(1);
	});

	it("settles a null cost for unpriced models", async () => {
		const seen = harness({
			priceTable: createPriceTable({
				fetch: (async () =>
					Response.json({
						"other-model": { input_cost_per_token: 1, output_cost_per_token: 1 },
					})) as unknown as typeof fetch,
			}),
		});
		const response = await handleChatCompletions(
			chatRequest(validBody(), "alice", "hr"),
			seen.deps,
		);
		expect(response.status).toBe(200);
		expect(seen.usageRows).toHaveLength(1);
		expect(seen.usageRows[0]?.costUsd).toBeNull();
	});

	it("settles a null cost when no price table is wired", async () => {
		const seen = harness();
		const response = await handleChatCompletions(
			chatRequest(validBody(), "alice", "hr"),
			seen.deps,
		);
		expect(response.status).toBe(200);
		expect(seen.usageRows[0]?.costUsd).toBeNull();
	});

	it("blocks a refused prompt before reaching upstream", async () => {
		const seen = harness({ pipeline: pipelineWith([blockOn("EVIL")]) });
		const response = await handleChatCompletions(
			chatRequest(
				validBody({ messages: [{ content: "this is EVIL", role: "user" }] }),
				"alice",
				"hr",
			),
			seen.deps,
		);
		expect(response.status).toBe(403);
		const body = (await response.json()) as ErrorBody;
		expect(body.error).toBe("blocked");
		expect(seen.upstreamBodies).toHaveLength(0);
		expect(seen.usageRows).toHaveLength(0);
	});

	it("forwards the redacted prompt upstream", async () => {
		const seen = harness({ pipeline: pipelineWith([redactOn("SECRET", "[TOKEN]")]) });
		const response = await handleChatCompletions(
			chatRequest(
				validBody({ messages: [{ content: "token SECRET here", role: "user" }] }),
				"alice",
				"hr",
			),
			seen.deps,
		);
		expect(response.status).toBe(200);
		const upstream = seen.upstreamBodies[0] as { messages: Array<{ content: string }> };
		expect(upstream.messages[0]?.content).toBe("token [TOKEN] here");
	});

	it("returns only the redacted answer", async () => {
		const seen = harness(
			{ pipeline: pipelineWith([redactOn("SECRET-9", "[TOKEN]", "outbound")]) },
			"leak SECRET-9 now",
		);
		const response = await handleChatCompletions(
			chatRequest(validBody(), "alice", "hr"),
			seen.deps,
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as CompletionBody;
		expect(body.choices[0]?.message.content).toBe("leak [TOKEN] now");
		// Tokens were spent upstream even though the answer was governed.
		expect(seen.usageRows).toHaveLength(1);
	});

	it("maps an upstream failure to 502", async () => {
		const seen = harness({
			upstreamFetch: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
		});
		const response = await handleChatCompletions(
			chatRequest(validBody(), "alice", "hr"),
			seen.deps,
		);
		expect(response.status).toBe(502);
		const body = (await response.json()) as ErrorBody;
		expect(body.error).toBe("upstream_error");
		expect(seen.usageRows).toHaveLength(0);
	});

	it("answers 503 when the model connection is unconfigured", async () => {
		const seen = harness({ baseUrl: undefined });
		const response = await handleChatCompletions(
			chatRequest(validBody(), "alice", "hr"),
			seen.deps,
		);
		expect(response.status).toBe(503);
		expect(seen.inspected).toHaveLength(0);
	});

	it("enforces a windowed budget across completions", async () => {
		let clock = 0;
		const tracker = createWindowedUsageTracker({
			limitTokens: 20,
			now: () => clock,
			windowMs: 1000,
		});
		const seen = harness({ onUsage: (row) => tracker.recordUsage(row), usageLimit: tracker });
		// Each completion settles 12 tokens: two fit in a 20-token window.
		for (const user of ["alice", "alice"]) {
			// biome-ignore lint/performance/noAwaitInLoops: completions settle in order against one window
			const response = await handleChatCompletions(chatRequest(validBody(), user, "hr"), seen.deps);
			expect(response.status).toBe(200);
		}
		const over = await handleChatCompletions(chatRequest(validBody(), "alice", "hr"), seen.deps);
		expect(over.status).toBe(429);
		// Another user is unaffected by alice's spend.
		const bob = await handleChatCompletions(chatRequest(validBody(), "bob", "hr"), seen.deps);
		expect(bob.status).toBe(200);
		// Past the window edge the budget rolls over.
		clock += 1000;
		const rolled = await handleChatCompletions(chatRequest(validBody(), "alice", "hr"), seen.deps);
		expect(rolled.status).toBe(200);
	});
});

describe("windowed usage tracker", () => {
	function row(total: number, userId = "alice"): GatewayUsageRow {
		return {
			completionTokens: total,
			costUsd: null,
			groupId: "hr",
			model: "test-model",
			promptTokens: 0,
			totalTokens: total,
			userId,
		};
	}

	it("allows under the limit and blocks at it", async () => {
		const clock = 0;
		const tracker = createWindowedUsageTracker({
			limitTokens: 10,
			now: () => clock,
			windowMs: 100,
		});
		expect(await tracker.checkUsage({ groupId: "hr", userId: "alice" })).toEqual({ ok: true });
		tracker.recordUsage(row(6));
		expect(tracker.usageOf("alice")).toBe(6);
		expect(await tracker.checkUsage({ groupId: "hr", userId: "alice" })).toEqual({ ok: true });
		tracker.recordUsage(row(4));
		const decision = await tracker.checkUsage({ groupId: "hr", userId: "alice" });
		expect(decision.ok).toBe(false);
	});

	it("rolls the window over past its edge", async () => {
		let clock = 0;
		const tracker = createWindowedUsageTracker({
			limitTokens: 10,
			now: () => clock,
			windowMs: 100,
		});
		tracker.recordUsage(row(10));
		expect((await tracker.checkUsage({ groupId: "hr", userId: "alice" })).ok).toBe(false);
		clock += 100;
		expect(await tracker.checkUsage({ groupId: "hr", userId: "alice" })).toEqual({ ok: true });
		expect(tracker.usageOf("alice")).toBe(0);
	});

	it("isolates users from each other's spend", async () => {
		const tracker = createWindowedUsageTracker({ limitTokens: 10, windowMs: 100 });
		tracker.recordUsage(row(10, "alice"));
		expect((await tracker.checkUsage({ groupId: "hr", userId: "alice" })).ok).toBe(false);
		expect(await tracker.checkUsage({ groupId: "hr", userId: "bob" })).toEqual({ ok: true });
	});
});
