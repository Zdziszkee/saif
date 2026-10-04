// biome-ignore-all lint/style/useNamingConvention: OpenAI wire format requires snake_case fields
import { describe, expect, it } from "bun:test";
import { createOpenAICompatibleConnection, ModelConfigurationError } from "#/hub/model.ts";
import { basicBuiltinTools } from "#/hub/tools.ts";

interface CapturedChatBody {
	messages?: unknown;
	model?: unknown;
	tools?: unknown;
}

interface CapturedChatCall {
	bodyJson: CapturedChatBody;
	headers: Record<string, string>;
	method: string;
	url: string;
}

function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") {
		return input;
	}
	if (input instanceof URL) {
		return input.toString();
	}
	return input.url;
}

function requestHeader(headers: Record<string, string>, name: string): string | undefined {
	return headers[name];
}

function createChatStub(payload: unknown, captured: CapturedChatCall): typeof fetch {
	return ((input: RequestInfo | URL, init?: RequestInit) => {
		const bodyText = typeof init?.body === "string" ? init.body : "{}";
		captured.bodyJson = JSON.parse(bodyText) as CapturedChatBody;
		captured.headers = { ...((init?.headers as Record<string, string> | undefined) ?? {}) };
		captured.method = init?.method ?? "";
		captured.url = requestUrl(input);
		return Promise.resolve(
			new Response(JSON.stringify(payload), {
				headers: { "Content-Type": "application/json" },
				status: 200,
			}),
		);
	}) as typeof fetch;
}

function emptyCapture(): CapturedChatCall {
	return { bodyJson: {}, headers: {}, method: "", url: "" };
}

function findBuiltin(name: string): (typeof basicBuiltinTools)[number] {
	const spec = basicBuiltinTools.find((tool) => tool.name === name);
	if (spec === undefined) {
		throw new Error(`missing builtin tool: ${name}`);
	}
	return spec;
}

function chatPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		choices: [
			{
				finish_reason: "stop",
				message: { content: "hello" },
			},
		],
		usage: { completion_tokens: 3, prompt_tokens: 5, total_tokens: 8 },
		...overrides,
	};
}

describe("model transport construction", () => {
	it("throws ModelConfigurationError when baseUrl is missing", () => {
		// Arrange
		const act = () => createOpenAICompatibleConnection({ modelName: "test-model" });

		// Act
		let message = "";
		try {
			act();
		} catch (error) {
			expect(error instanceof ModelConfigurationError).toBe(true);
			message = error instanceof Error ? error.message : String(error);
		}

		// Assert
		expect(message).toContain("MODEL_BASE_URL");
	});

	it("throws ModelConfigurationError when modelName is missing", () => {
		// Arrange
		const act = () => createOpenAICompatibleConnection({ baseUrl: "https://model.test" });

		// Act
		let message = "";
		try {
			act();
		} catch (error) {
			expect(error instanceof ModelConfigurationError).toBe(true);
			message = error instanceof Error ? error.message : String(error);
		}

		// Assert
		expect(message).toContain("MODEL_NAME");
	});

	it("exposes the configured modelName", () => {
		// Arrange
		const captured = emptyCapture();

		// Act
		const connection = createOpenAICompatibleConnection({
			baseUrl: "https://model.test",
			fetch: createChatStub(chatPayload(), captured),
			modelName: "test-model",
		});

		// Assert
		expect(connection.modelName).toBe("test-model");
	});

	it("trims a trailing slash from baseUrl", async () => {
		// Arrange
		const captured = emptyCapture();
		const connection = createOpenAICompatibleConnection({
			baseUrl: "https://model.test/",
			fetch: createChatStub(chatPayload(), captured),
			modelName: "test-model",
		});

		// Act
		await connection.complete({ messages: [{ content: "hi", role: "user" }] });

		// Assert
		expect(captured.url).toBe("https://model.test/chat/completions");
	});
});

describe("model request shaping", () => {
	it("posts JSON with model and messages", async () => {
		// Arrange
		const captured = emptyCapture();
		const connection = createOpenAICompatibleConnection({
			baseUrl: "https://model.test",
			fetch: createChatStub(chatPayload(), captured),
			modelName: "test-model",
		});

		// Act
		await connection.complete({ messages: [{ content: "hi", role: "user" }] });

		// Assert
		expect(captured.method).toBe("POST");
		expect(captured.headers["Content-Type"]).toBe("application/json");
		expect(captured.bodyJson.model).toBe("test-model");
		expect(captured.bodyJson.messages).toEqual([{ content: "hi", role: "user" }]);
	});

	it("sends Bearer Authorization when apiKey is present", async () => {
		// Arrange
		const captured = emptyCapture();
		const connection = createOpenAICompatibleConnection({
			apiKey: "test-key",
			baseUrl: "https://model.test",
			fetch: createChatStub(chatPayload(), captured),
			modelName: "test-model",
		});

		// Act
		await connection.complete({ messages: [{ content: "hi", role: "user" }] });

		// Assert
		expect(requestHeader(captured.headers, "Authorization")).toBe("Bearer test-key");
	});

	it("omits Authorization when apiKey is absent", async () => {
		// Arrange
		const captured = emptyCapture();
		const connection = createOpenAICompatibleConnection({
			baseUrl: "https://model.test",
			fetch: createChatStub(chatPayload(), captured),
			modelName: "test-model",
		});

		// Act
		await connection.complete({ messages: [{ content: "hi", role: "user" }] });

		// Assert
		expect(requestHeader(captured.headers, "Authorization")).toBeUndefined();
	});

	it("maps tool specs to OpenAI function tools", async () => {
		// Arrange
		const captured = emptyCapture();
		const connection = createOpenAICompatibleConnection({
			baseUrl: "https://model.test",
			fetch: createChatStub(chatPayload(), captured),
			modelName: "test-model",
		});

		// Act
		await connection.complete({
			messages: [{ content: "hi", role: "user" }],
			tools: [{ description: "Add a todo", inputSchema: { type: "object" }, name: "addTodo" }],
		});

		// Assert
		expect(captured.bodyJson.tools).toEqual([
			{
				function: {
					description: "Add a todo",
					name: "addTodo",
					parameters: { type: "object" },
				},
				type: "function",
			},
		]);
	});

	it("omits the tools key when the request has no tools", async () => {
		// Arrange
		const captured = emptyCapture();
		const connection = createOpenAICompatibleConnection({
			baseUrl: "https://model.test",
			fetch: createChatStub(chatPayload(), captured),
			modelName: "test-model",
		});

		// Act
		await connection.complete({ messages: [{ content: "hi", role: "user" }] });

		// Assert
		expect("tools" in captured.bodyJson).toBe(false);
	});

	it("forwards an AbortSignal through transport without breaking the call", async () => {
		// Arrange
		const captured = emptyCapture();
		const connection = createOpenAICompatibleConnection({
			baseUrl: "https://model.test",
			fetch: createChatStub(chatPayload(), captured),
			modelName: "test-model",
		});
		const controller = new AbortController();

		// Act
		const reply = await connection.complete(
			{ messages: [{ content: "hi", role: "user" }] },
			{ signal: controller.signal },
		);

		// Assert
		expect(reply.text).toBe("hello");
		expect(captured.url).toBe("https://model.test/chat/completions");
	});
});

describe("model completion parsing", () => {
	it("returns text, finishReason, and usage on a full payload", async () => {
		// Arrange
		const captured = emptyCapture();
		const connection = createOpenAICompatibleConnection({
			baseUrl: "https://model.test",
			fetch: createChatStub(chatPayload(), captured),
			modelName: "test-model",
		});

		// Act
		const reply = await connection.complete({ messages: [{ content: "hi", role: "user" }] });

		// Assert
		expect(reply.finishReason).toBe("stop");
		expect(reply.text).toBe("hello");
		expect(reply.toolCalls).toEqual([]);
		expect(reply.usage).toEqual({ completionTokens: 3, promptTokens: 5, totalTokens: 8 });
	});

	it("defaults usage to zeros when usage is missing", async () => {
		// Arrange
		const captured = emptyCapture();
		const connection = createOpenAICompatibleConnection({
			baseUrl: "https://model.test",
			fetch: createChatStub(
				{
					choices: [{ finish_reason: "stop", message: { content: "hi" } }],
				},
				captured,
			),
			modelName: "test-model",
		});

		// Act
		const reply = await connection.complete({ messages: [{ content: "hi", role: "user" }] });

		// Assert
		expect(reply.usage).toEqual({ completionTokens: 0, promptTokens: 0, totalTokens: 0 });
	});

	it("defaults text and finishReason when optional chat fields are missing", async () => {
		// Arrange
		const captured = emptyCapture();
		const connection = createOpenAICompatibleConnection({
			baseUrl: "https://model.test",
			fetch: createChatStub(
				{
					choices: [{ message: { content: null } }],
					usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
				},
				captured,
			),
			modelName: "test-model",
		});

		// Act
		const reply = await connection.complete({ messages: [{ content: "hi", role: "user" }] });

		// Assert
		expect(reply.finishReason).toBe("stop");
		expect(reply.text).toBe("");
	});

	it("maps tool_calls entries to toolCalls", async () => {
		// Arrange
		const captured = emptyCapture();
		const connection = createOpenAICompatibleConnection({
			baseUrl: "https://model.test",
			fetch: createChatStub(
				{
					choices: [
						{
							finish_reason: "tool_calls",
							message: {
								content: null,
								tool_calls: [
									{
										function: { arguments: '{"title":"buy milk"}', name: "addTodo" },
										id: "call_1",
									},
								],
							},
						},
					],
					usage: { completion_tokens: 2, prompt_tokens: 4, total_tokens: 6 },
				},
				captured,
			),
			modelName: "test-model",
		});

		// Act
		const reply = await connection.complete({ messages: [{ content: "hi", role: "user" }] });

		// Assert
		expect(reply.finishReason).toBe("tool_calls");
		expect(reply.toolCalls).toHaveLength(1);
		expect(reply.toolCalls.at(0)?.id).toBe("call_1");
		expect(reply.toolCalls.at(0)?.name).toBe("addTodo");
		expect(reply.toolCalls.at(0)?.arguments).toBe('{"title":"buy milk"}');
	});

	it("throws an HTTP error when the endpoint is not ok", async () => {
		// Arrange
		const failingFetch = (() =>
			Promise.resolve(new Response("boom", { status: 500 }))) as unknown as typeof fetch;
		const connection = createOpenAICompatibleConnection({
			baseUrl: "https://model.test",
			fetch: failingFetch,
			modelName: "test-model",
		});

		// Act
		const outcome = await connection.complete({ messages: [{ content: "hi", role: "user" }] }).then(
			() => ({ message: "" }),
			(error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }),
		);

		// Assert
		expect(outcome.message).toContain("HTTP 500");
	});

	it("throws an unusable-completion error when choices are empty", async () => {
		// Arrange
		const captured = emptyCapture();
		const connection = createOpenAICompatibleConnection({
			baseUrl: "https://model.test",
			fetch: createChatStub({ choices: [] }, captured),
			modelName: "test-model",
		});

		// Act
		const outcome = await connection.complete({ messages: [{ content: "hi", role: "user" }] }).then(
			() => ({ message: "" }),
			(error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }),
		);

		// Assert
		expect(outcome.message).toContain("unusable chat completion");
	});

	it("throws an unusable-completion error when usage fields are string-coerced", async () => {
		// Arrange
		const captured = emptyCapture();
		const connection = createOpenAICompatibleConnection({
			baseUrl: "https://model.test",
			fetch: createChatStub(
				{
					choices: [{ finish_reason: "stop", message: { content: "hi" } }],
					usage: { completion_tokens: "3", prompt_tokens: "5", total_tokens: "8" },
				},
				captured,
			),
			modelName: "test-model",
		});

		// Act
		const outcome = await connection.complete({ messages: [{ content: "hi", role: "user" }] }).then(
			() => ({ message: "" }),
			(error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }),
		);

		// Assert
		expect(outcome.message).toContain("unusable chat completion");
	});

	it("throws an unusable-completion error when usage is partial", async () => {
		// Arrange
		const captured = emptyCapture();
		const connection = createOpenAICompatibleConnection({
			baseUrl: "https://model.test",
			fetch: createChatStub(
				{
					choices: [{ finish_reason: "stop", message: { content: "hi" } }],
					usage: { completion_tokens: 3, prompt_tokens: 5 },
				},
				captured,
			),
			modelName: "test-model",
		});

		// Act
		const outcome = await connection.complete({ messages: [{ content: "hi", role: "user" }] }).then(
			() => ({ message: "" }),
			(error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }),
		);

		// Assert
		expect(outcome.message).toContain("unusable chat completion");
	});
});

describe("builtin tools", () => {
	it("addTodo returns the created todo with the given title", async () => {
		// Arrange
		const spec = findBuiltin("addTodo");
		const title = "hub-model-tools addTodo probe";

		// Act
		const raw = await spec.implementation({ title }, "test-subject");

		// Assert
		const result = raw as { id: number; title: string };
		expect(result.title).toBe(title);
		expect(typeof result.id).toBe("number");
	});

	it("listTodos returns the current todos array", async () => {
		// Arrange
		const spec = findBuiltin("listTodos");

		// Act
		const raw = await spec.implementation({}, "test-subject");

		// Assert
		const result = raw as { todos: Array<{ id: number; title: string }> };
		expect(Array.isArray(result.todos)).toBe(true);
	});

	it("deleteAllTodos reports how many todos were removed", async () => {
		// Arrange
		const addSpec = findBuiltin("addTodo");
		const deleteSpec = findBuiltin("deleteAllTodos");
		const listSpec = findBuiltin("listTodos");
		await addSpec.implementation({ title: "hub-model-tools delete probe" }, "test-subject");

		// Act
		const raw = await deleteSpec.implementation({}, "test-subject");

		// Assert
		const result = raw as { deleted: number };
		expect(typeof result.deleted).toBe("number");
		expect(result.deleted).toBeGreaterThanOrEqual(1);
		const afterRaw = await listSpec.implementation({}, "test-subject");
		const after = afterRaw as { todos: unknown[] };
		expect(Array.isArray(after.todos)).toBe(true);
	});

	it("fetchUrl returns status and truncated body", async () => {
		// Arrange
		const spec = findBuiltin("fetchUrl");
		const longBody = "x".repeat(20_005);
		const seen: { url?: string } = {};
		const stub = ((input: RequestInfo | URL) => {
			seen.url = requestUrl(input);
			return Promise.resolve(new Response(longBody, { status: 200 }));
		}) as typeof fetch;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = stub;

		try {
			// Act
			const raw = await spec.implementation({ url: "https://example.test/page" }, "test-subject");

			// Assert
			const result = raw as { body: string; status: number };
			expect(result.status).toBe(200);
			expect(result.body).toHaveLength(20_000);
			expect(seen.url).toBe("https://example.test/page");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("fetchUrl propagates a network failure", async () => {
		// Arrange
		const spec = findBuiltin("fetchUrl");
		const stub = (() => Promise.reject(new Error("network down"))) as unknown as typeof fetch;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = stub;

		try {
			// Act
			let message = "";
			try {
				await spec.implementation({ url: "https://example.test/page" }, "test-subject");
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}

			// Assert
			expect(message).toContain("network down");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("rejects an empty addTodo title at the input schema", () => {
		// Arrange
		const spec = findBuiltin("addTodo");

		// Act
		const parsed = spec.inputSchema.safeParse({ title: "" });

		// Assert
		expect(parsed.success).toBe(false);
	});

	it("rejects a non-URL fetchUrl input at the input schema", () => {
		// Arrange
		const spec = findBuiltin("fetchUrl");

		// Act
		const parsed = spec.inputSchema.safeParse({ url: "not-a-url" });

		// Assert
		expect(parsed.success).toBe(false);
	});
});
