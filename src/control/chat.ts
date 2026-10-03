/**
 * Minimal chat seam (tasks 11.2, re-scoped): the pipeline wired over prompt
 * and answer around a model-reaching `ask` callback, via `guardInteraction()`.
 *
 * The seam is deliberately not dependent on the hub — `ask` is injected. In
 * the product wiring `ask` is the hub's `askModel`, keeping the hub's MCP
 * surface the only model-reaching interface.
 */

import type { AuditSink } from "./audit.ts";
import { guardInteraction } from "./guard.ts";
import type { ControlPipeline, Verdict } from "./types.ts";

let chatSequence = 0;

function nextChatInteractionId(): string {
	chatSequence += 1;
	return `chat_${Date.now()}_${chatSequence}`;
}

export type ChatAsk = (prompt: string) => Promise<string>;

export interface ChatSeamOptions {
	ask: ChatAsk;
	audit?: AuditSink | undefined;
	pipeline: ControlPipeline;
	subject: string;
}

export interface ChatSeamOutcome {
	/** The governed answer; present only when the prompt was forwarded. */
	answer?: string | undefined;
	/** Verdict applied to the inbound prompt direction. */
	promptVerdict: Verdict;
	/** Defined rejection for the direction that refused forwarding. */
	rejection?: { control: string; status: number; verdict: Verdict } | undefined;
	/** Verdict applied to the outbound answer direction (the outcome verdict). */
	verdict: Verdict;
}

export async function guardedChat(
	prompt: string,
	options: ChatSeamOptions,
): Promise<ChatSeamOutcome> {
	const promptOutcome = await guardInteraction(
		{
			content: prompt,
			direction: "inbound",
			id: nextChatInteractionId(),
			seam: "chat",
			subject: options.subject,
		},
		options.pipeline,
		{ audit: options.audit },
	);
	if (promptOutcome.rejection) {
		return {
			promptVerdict: promptOutcome.verdict,
			rejection: promptOutcome.rejection,
			verdict: promptOutcome.verdict,
		};
	}

	const rawAnswer = await options.ask(promptOutcome.content ?? prompt);
	const answerOutcome = await guardInteraction(
		{
			content: rawAnswer,
			direction: "outbound",
			id: nextChatInteractionId(),
			seam: "chat",
			subject: options.subject,
		},
		options.pipeline,
		{ audit: options.audit },
	);
	return {
		answer: answerOutcome.content,
		promptVerdict: promptOutcome.verdict,
		rejection: answerOutcome.rejection,
		verdict: answerOutcome.verdict,
	};
}
