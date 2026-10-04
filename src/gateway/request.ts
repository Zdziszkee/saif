/**
 * OpenAI chat-completions request shape for the LLM gateway seam.
 *
 * Parses the harness-facing `POST /v1/chat/completions` body and extracts
 * the new user content for validation. Unknown OpenAI fields (temperature,
 * tools, top_p, ...) are preserved so they can be forwarded upstream
 * unchanged; only the fields the gateway governs are validated.
 */

import { z } from "zod";

const MAX_MESSAGE_COUNT = 512;
const MAX_MODEL_LENGTH = 256;
const USER_ROLE = "user";

const contentPartSchema = z.looseObject({
	text: z.string().optional(),
	type: z.string(),
});

const messageContentSchema = z.union([z.string(), z.array(contentPartSchema)]);

const chatMessageSchema = z.looseObject({
	content: messageContentSchema,
	role: z.string().min(1),
});

const chatCompletionsSchema = z.looseObject({
	messages: z.array(chatMessageSchema).min(1).max(MAX_MESSAGE_COUNT),
	model: z.string().min(1).max(MAX_MODEL_LENGTH).optional(),
	stream: z.boolean().optional(),
});

export type GatewayChatMessage = z.infer<typeof chatMessageSchema>;
export type GatewayChatBody = z.infer<typeof chatCompletionsSchema>;

export type GatewayBodyValidation =
	| { body: GatewayChatBody; ok: true }
	| { errors: string[]; ok: false };

/**
 * Validate the OpenAI body. Malformed requests are rejected with a client
 * error before any control tier runs.
 */
export function parseGatewayBody(input: unknown): GatewayBodyValidation {
	const parsed = chatCompletionsSchema.safeParse(input);
	if (!parsed.success) {
		return {
			errors: parsed.error.issues.map((issue) => {
				const path = issue.path.length > 0 ? issue.path.join(".") : "request";
				return `${path}: ${issue.message}`;
			}),
			ok: false,
		};
	}
	return { body: parsed.data, ok: true };
}

/** One user message and its position, so redactions map back to messages. */
export interface UserSlice {
	index: number;
	text: string;
}

/** Text of one message: strings as-is, part arrays joined, non-text dropped. */
export function messageText(message: GatewayChatMessage): string {
	if (typeof message.content === "string") {
		return message.content;
	}
	return message.content
		.filter((part) => part.text !== undefined)
		.map((part) => part.text ?? "")
		.join("");
}

/**
 * The new user content: user-role messages only. Assistant messages (model
 * answers kept in the history) are never inspected.
 */
export function userSlices(body: GatewayChatBody): UserSlice[] {
	const slices: UserSlice[] = [];
	body.messages.forEach((message, index) => {
		if (message.role === USER_ROLE) {
			slices.push({ index, text: messageText(message) });
		}
	});
	return slices;
}
