/**
 * OpenAI-compatible model connection — the hub's single model-reaching
 * transport (MCP safety hub requirement). Configured by environment variables
 * (endpoint base URL, model name, API key) so any local or hosted endpoint
 * implementing the OpenAI-compatible chat-completions interface works without
 * code changes.
 */

import { z } from "zod";

export interface ModelToolCall {
	arguments: string;
	id: string;
	name: string;
}

export interface ModelToolCallRequest {
	function: { arguments: string; name: string };
	id: string;
	type: "function";
}

export interface ModelMessage {
	content: string;
	name?: string | undefined;
	role: "assistant" | "system" | "tool" | "user";
	toolCallId?: string | undefined;
	toolCalls?: ModelToolCallRequest[] | undefined;
}

export interface ModelToolSpec {
	description: string;
	inputSchema: Record<string, unknown>;
	name: string;
}

export interface ModelUsage {
	completionTokens: number;
	promptTokens: number;
	totalTokens: number;
}

export interface ModelReply {
	finishReason: string;
	text: string;
	toolCalls: ModelToolCall[];
	usage: ModelUsage;
}

export interface ModelRequest {
	messages: ModelMessage[];
	tools?: ModelToolSpec[] | undefined;
}

export interface ModelConnection {
	complete(request: ModelRequest, options?: { signal?: AbortSignal }): Promise<ModelReply>;
	readonly modelName: string;
}

export class ModelConfigurationError extends Error {
	override readonly name = "ModelConfigurationError";
}

export interface OpenAICompatibleConfig {
	apiKey?: string | undefined;
	baseUrl?: string | undefined;
	fetch?: typeof fetch | undefined;
	modelName?: string | undefined;
	timeoutMs?: number | undefined;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const TRAILING_SLASH = /\/$/;

interface ChatRequestBody {
	messages: ModelMessage[];
	model: string;
	tools?: Array<{
		function: { description: string; name: string; parameters: Record<string, unknown> };
		type: "function";
	}>;
}

const chatCompletionSchema = z.object({
	choices: z
		.array(
			z.object({
				finish_reason: z.string().optional(),
				message: z.object({
					content: z.string().nullish(),
					tool_calls: z
						.array(
							z.object({
								function: z.object({ arguments: z.string(), name: z.string() }),
								id: z.string(),
							}),
						)
						.optional(),
				}),
			}),
		)
		.min(1),
	usage: z
		.object({
			completion_tokens: z.number(),
			prompt_tokens: z.number(),
			total_tokens: z.number(),
		})
		.optional(),
});

export function createOpenAICompatibleConnection(config: OpenAICompatibleConfig): ModelConnection {
	const baseUrl = config.baseUrl?.replace(TRAILING_SLASH, "");
	const modelName = config.modelName;
	if (!(baseUrl && modelName)) {
		throw new ModelConfigurationError(
			"Model connection is not configured: set MODEL_BASE_URL and MODEL_NAME " +
				"(and MODEL_API_KEY when the endpoint requires one) to reach a model.",
		);
	}
	const fetchFn = config.fetch ?? fetch;
	const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	return {
		async complete(request: ModelRequest, options?: { signal?: AbortSignal }): Promise<ModelReply> {
			const response = await postChatCompletion(baseUrl, buildChatBody(request, modelName), {
				apiKey: config.apiKey,
				fetchFn,
				signal: options?.signal,
				timeoutMs,
			});
			if (!response.ok) {
				throw new Error(`model endpoint returned HTTP ${response.status}`);
			}
			return parseChatCompletion(await response.json());
		},
		modelName,
	};
}

function buildChatBody(request: ModelRequest, modelName: string): ChatRequestBody {
	const body: ChatRequestBody = {
		messages: request.messages,
		model: modelName,
	};
	if (request.tools && request.tools.length > 0) {
		body.tools = request.tools.map((tool) => ({
			function: {
				description: tool.description,
				name: tool.name,
				parameters: tool.inputSchema,
			},
			type: "function",
		}));
	}
	return body;
}

async function postChatCompletion(
	baseUrl: string,
	body: ChatRequestBody,
	transport: {
		apiKey: string | undefined;
		fetchFn: typeof fetch;
		signal: AbortSignal | undefined;
		timeoutMs: number;
	},
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort();
	}, transport.timeoutMs);
	const onAbort = () => {
		controller.abort();
	};
	transport.signal?.addEventListener("abort", onAbort);
	try {
		return await transport.fetchFn(`${baseUrl}/chat/completions`, {
			body: JSON.stringify(body),
			headers: {
				"Content-Type": "application/json",
				...(transport.apiKey ? { Authorization: `Bearer ${transport.apiKey}` } : {}),
			},
			method: "POST",
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timer);
		transport.signal?.removeEventListener("abort", onAbort);
	}
}

function parseChatCompletion(payload: unknown): ModelReply {
	const parsed = chatCompletionSchema.safeParse(payload);
	if (!parsed.success) {
		throw new Error("model endpoint returned an unusable chat completion");
	}
	const choice = parsed.data.choices[0];
	if (!choice) {
		throw new Error("model endpoint returned no choices");
	}
	return {
		finishReason: choice.finish_reason ?? "stop",
		text: choice.message.content ?? "",
		toolCalls: (choice.message.tool_calls ?? []).map((call) => ({
			arguments: call.function.arguments,
			id: call.id,
			name: call.function.name,
		})),
		usage: parsed.data.usage
			? {
					completionTokens: parsed.data.usage.completion_tokens,
					promptTokens: parsed.data.usage.prompt_tokens,
					totalTokens: parsed.data.usage.total_tokens,
				}
			: { completionTokens: 0, promptTokens: 0, totalTokens: 0 },
	};
}
