/**
 * OpenAI Chat Completions wire format for the LLM gateway.
 *
 * Agent harnesses (opencode and similar) point their provider `baseURL` at
 * this service, so request parsing must accept the full OpenAI shape while
 * only the fields gating needs are validated: `model`, `messages`, and the
 * `stream` flag everything else passes through untouched. Response helpers
 * cover the harness-visible error shape and SSE usage extraction.
 */

import { z } from "zod";

/** Minimal fetch surface: satisfied by the global fetch and by test doubles. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const textPartSchema = z.looseObject({ text: z.string(), type: z.string() });

const messageSchema = z.looseObject({ content: z.unknown(), role: z.string() });

const chatRequestSchema = z
	.looseObject({
		messages: z.array(messageSchema).min(1),
		model: z.string().min(1),
		stream: z.boolean().optional(),
	})
	.passthrough();

export type ChatRequest = z.infer<typeof chatRequestSchema>;

export interface ParseChatRequest {
	body: ChatRequest;
	/** Raw document, forwarded with surgical modifications. */
	document: Record<string, unknown>;
}

export function parseChatRequest(input: unknown): ParseChatRequest | { errors: string[] } {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return { errors: ["request: expected a JSON object"] };
	}
	const parsed = chatRequestSchema.safeParse(input);
	if (!parsed.success) {
		return {
			errors: parsed.error.issues.map((issue) => {
				const path = issue.path.length > 0 ? issue.path.join(".") : "request";
				return `${path}: ${issue.message}`;
			}),
		};
	}
	return { body: parsed.data, document: input as Record<string, unknown> };
}

/** One gateable text unit: user and system text parts, in order. */
export interface TextPart {
	messageIndex: number;
	partIndex: number;
	text: string;
}

/** Gated roles: user prompts and system instructions. History and tool payloads pass through. */
export function isGatedRole(role: string): boolean {
	return role === "user" || role === "system";
}

function textOfPart(part: unknown): string | null {
	const text = textPartSchema.safeParse(part);
	if (!text.success || text.data.type !== "text") {
		return null;
	}
	return text.data.text;
}

/** Extract gateable text parts, preserving their positions for rebuild. */
export function extractTextParts(
	messages: readonly { content: unknown; role: string }[],
): TextPart[] {
	const parts: TextPart[] = [];
	for (const [messageIndex, message] of messages.entries()) {
		if (!isGatedRole(message.role)) {
			continue;
		}
		if (typeof message.content === "string") {
			parts.push({ messageIndex, partIndex: -1, text: message.content });
			continue;
		}
		if (!Array.isArray(message.content)) {
			continue;
		}
		for (const [partIndex, part] of message.content.entries()) {
			const text = textOfPart(part);
			if (text !== null) {
				parts.push({ messageIndex, partIndex, text });
			}
		}
	}
	return parts;
}

/** Rebuild messages with redacted part text; structure is otherwise untouched. */
export function rebuildMessages(
	messages: readonly { content: unknown; role: string }[],
	redacted: ReadonlyMap<string, string>,
): unknown[] {
	return messages.map((message, messageIndex) => {
		if (typeof message.content === "string") {
			const replacement = redacted.get(`${messageIndex}:-1`);
			return replacement === undefined ? message : { ...message, content: replacement };
		}
		if (!Array.isArray(message.content)) {
			return message;
		}
		return {
			...message,
			content: message.content.map((part, partIndex) => {
				const replacement = redacted.get(`${messageIndex}:${partIndex}`);
				if (replacement === undefined || typeof part !== "object" || part === null) {
					return part;
				}
				return { ...part, text: replacement };
			}),
		};
	});
}

/** Provider usage block in OpenAI wire shape (snake_case by specification). */
export interface ProviderUsage {
	usage?:
		| {
				completion_tokens?: unknown;
				prompt_tokens?: unknown;
		  }
		| undefined;
}

/** Harness-visible error body in the OpenAI error shape. */
export function openAiError(message: string, code: string): Record<string, unknown> {
	return { error: { code, message, type: "saif_guard" } };
}

const SSE_DATA_PREFIX = "data: ";
const SSE_DONE_PAYLOAD = "[DONE]";

interface SseUsage {
	completionTokens: number;
	promptTokens: number;
}

function parseSseLine(line: string): SseUsage | null {
	if (!line.startsWith(SSE_DATA_PREFIX)) {
		return null;
	}
	const payload = line.slice(SSE_DATA_PREFIX.length).trim();
	if (payload === "" || payload === SSE_DONE_PAYLOAD) {
		return null;
	}
	let data: unknown = null;
	try {
		data = JSON.parse(payload) as unknown;
	} catch {
		return null;
	}
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const usage = (data as { usage?: unknown }).usage;
	if (typeof usage !== "object" || usage === null) {
		return null;
	}
	const tokens = usage as { completion_tokens?: unknown; prompt_tokens?: unknown };
	if (typeof tokens.prompt_tokens !== "number" || typeof tokens.completion_tokens !== "number") {
		return null;
	}
	return { completionTokens: tokens.completion_tokens, promptTokens: tokens.prompt_tokens };
}

/**
 * Scan buffered SSE text for the last usage payload (present when the
 * provider was asked with `stream_options: { include_usage: true }`).
 */
export function extractSseUsage(buffer: string): SseUsage | null {
	let usage: SseUsage | null = null;
	for (const line of buffer.split("\n")) {
		usage = parseSseLine(line) ?? usage;
	}
	return usage;
}
