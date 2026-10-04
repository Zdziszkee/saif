/**
 * Request shape validation (interaction-gateway requirement).
 *
 * Malformed requests are rejected before any control evaluation runs: the
 * envelope must match the expected interaction schema and content is bounded.
 */

import { z } from "zod";
import type { Interaction, InteractionSeam } from "./types.ts";

/** Maximum inspected content size (bytes of UTF-8 text), per the L0 shape limit. */
export const MAX_CONTENT_LENGTH = 65_536;

/** Maximum length of envelope identifiers, model names, and tool names. */
const MAX_SHORT_FIELD_LENGTH = 128;

const MAX_MODEL_FIELD_LENGTH = 256;

export const interactionRequestSchema = z.strictObject({
	content: z.string().min(1).max(MAX_CONTENT_LENGTH),
	direction: z.enum(["inbound", "outbound"]),
	id: z.string().min(1).max(MAX_SHORT_FIELD_LENGTH).optional(),
	model: z.string().min(1).max(MAX_MODEL_FIELD_LENGTH).optional(),
	seam: z.enum(["chat", "mcp-tool", "guard-api"]),
	tool: z
		.strictObject({
			arguments: z.unknown().optional(),
			name: z.string().min(1).max(MAX_SHORT_FIELD_LENGTH),
		})
		.optional(),
});

export type InteractionRequest = z.infer<typeof interactionRequestSchema>;

export type ShapeValidation =
	| { ok: true; interaction: Interaction }
	| { ok: false; errors: string[] };

let nextId = 0;

function generateInteractionId(): string {
	nextId += 1;
	return `int_${Date.now()}_${nextId}`;
}

/**
 * Validate the request envelope. Caller identity comes from the resolved
 * `x-user-id` / `x-user-group-id` headers, never from the request body.
 */
export function parseInteractionRequest(
	input: unknown,
	identity: { groupId: string; userId: string },
): ShapeValidation {
	const parsed = interactionRequestSchema.safeParse(input);
	if (!parsed.success) {
		return {
			errors: parsed.error.issues.map((issue) => {
				const path = issue.path.length > 0 ? issue.path.join(".") : "request";
				return `${path}: ${issue.message}`;
			}),
			ok: false,
		};
	}
	const request = parsed.data;
	const seam: InteractionSeam = request.seam;
	return {
		interaction: {
			content: request.content,
			direction: request.direction,
			groupId: identity.groupId,
			id: request.id ?? generateInteractionId(),
			model: request.model,
			seam,
			tool: request.tool
				? { arguments: request.tool.arguments, name: request.tool.name }
				: undefined,
			userId: identity.userId,
		},
		ok: true,
	};
}
