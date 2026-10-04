/**
 * Minimal chat seam (tasks 11.2, re-scoped): the pipeline wired over prompt
 * and answer around a model-reaching `ask` callback, via `guardInteraction()`.
 *
 * The seam is deliberately not dependent on the gateway — `ask` is injected.
 * In the product wiring `ask` is the prompt-plane gateway's ask (design D10);
 * the hub's MCP surface is tools-only.
 */

import { type GovernedLoopTool, type LoopBudgets, runGovernedLoop } from "#/hub/loop.ts";
import type { ModelConnection } from "#/hub/model.ts";
import { createIdSequence } from "#/lib/ids.ts";
import type { AuditSink } from "./audit.ts";
import { guardInteraction } from "./guard.ts";
import type { ControlPipeline, Verdict } from "./types.ts";

const nextChatInteractionId = createIdSequence("chat");

export type ChatAsk = (prompt: string) => Promise<string>;

export interface ChatSeamOptions {
	ask: ChatAsk;
	audit?: AuditSink | undefined;
	groupId: string;
	pipeline: ControlPipeline;
	userId: string;
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
	// Both directions audit under the caller's user id. `userId` is required
	// here, so unlike header-derived ids no `?? "(none)"` fallback applies.
	const guardOptions = { audit: options.audit, consumerKey: options.userId };
	const promptOutcome = await guardInteraction(
		{
			content: prompt,
			direction: "inbound",
			groupId: options.groupId,
			id: nextChatInteractionId(),
			seam: "chat",
			userId: options.userId,
		},
		options.pipeline,
		guardOptions,
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
			groupId: options.groupId,
			id: nextChatInteractionId(),
			seam: "chat",
			userId: options.userId,
		},
		options.pipeline,
		guardOptions,
	);
	return {
		answer: answerOutcome.content,
		promptVerdict: promptOutcome.verdict,
		rejection: answerOutcome.rejection,
		verdict: answerOutcome.verdict,
	};
}

/**
 * Gateway `ask` wiring (task 9.4): the prompt-plane gateway's model-reaching
 * callback over the hub's model connection and governed tool loop.
 *
 * The prompt and answer still flow through `guardInteraction()` above (this
 * wiring only supplies the `ask`); between them the loop reuses the hub's
 * bound predicates — `maxIterations` maps to the request-count budget and
 * `maxComputeMs` to the compute-time budget — and every tool call executes
 * through the caller-supplied governed tools. Bind each tool's `execute` to
 * hub tool-call governance (grant check, confirmation gate, argument and
 * result inspection) before passing it in: the loop never calls bare
 * implementations. `enforcement: "tool"` turns a refused call into a tool
 * error and continues the turn; `"turn"` rejects the whole turn.
 */

const DEFAULT_GATEWAY_MAX_ITERATIONS = 8;
const DEFAULT_GATEWAY_MAX_COMPUTE_MS = 60_000;

export interface GatewayAskOptions {
	connection: ModelConnection;
	enforcement?: "tool" | "turn" | undefined;
	maxComputeMs?: number | undefined;
	maxIterations?: number | undefined;
	systemPrompt?: string | undefined;
	tools?: GovernedLoopTool[] | undefined;
}

/** Raised when the governed loop ends without an answer. */
export class GatewayAskTerminatedError extends Error {
	override readonly name = "GatewayAskTerminatedError";
	readonly kind: "over-budget" | "turn-rejected";

	constructor(
		kind: "over-budget" | "turn-rejected",
		detail: string,
		options?: { cause?: unknown },
	) {
		super(`gateway ask terminated (${kind}): ${detail}`, options);
		this.kind = kind;
	}
}

export function createGatewayAsk(options: GatewayAskOptions): ChatAsk {
	const budgets: LoopBudgets = {
		maxComputeMs: options.maxComputeMs ?? DEFAULT_GATEWAY_MAX_COMPUTE_MS,
		maxToolRounds: options.maxIterations ?? DEFAULT_GATEWAY_MAX_ITERATIONS,
	};
	const enforcement = options.enforcement ?? "tool";
	return async (prompt: string): Promise<string> => {
		const result = await runGovernedLoop(prompt, {
			budgets,
			enforcement,
			model: options.connection,
			...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
			tools: options.tools ?? [],
		});
		if (result.kind === "answer") {
			return result.answer;
		}
		if (result.kind === "over-budget") {
			throw new GatewayAskTerminatedError(
				"over-budget",
				`loop budget exceeded after ${result.rounds} round(s)`,
				{ cause: result },
			);
		}
		throw new GatewayAskTerminatedError(
			"turn-rejected",
			`tool turn rejected by ${result.rejection.control}`,
			{ cause: result.rejection },
		);
	};
}
