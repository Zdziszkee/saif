/**
 * Governed agentic tool loop (MCP safety hub requirement).
 *
 * When the model returns tool calls, the hub executes them through hub-hosted
 * and connected tools under tool-call governance and feeds the governed
 * results back to the model until a final answer is produced. The loop is
 * bounded by the applicable request-count and compute-time budgets; exceeding
 * either terminates the loop and reports the over-budget verdict (default
 * `block`) instead of continuing.
 */

import type { Verdict } from "#/control/types.ts";
import { parseJsonOrEmpty } from "#/lib/json.ts";
import {
	definedConfirmation,
	definedRejection,
	type ToolCallOutcome,
	type ToolRejection,
} from "./governance.ts";
import type { ModelConnection, ModelMessage, ModelReply, ModelToolSpec } from "./model.ts";

export interface LoopBudgets {
	/** Compute-time budget for the whole loop, in milliseconds. */
	maxComputeMs: number;
	/** Request-count budget: maximum model requests per loop. */
	maxToolRounds: number;
}

export interface GovernedLoopTool {
	execute(args: unknown): Promise<ToolCallOutcome>;
	spec: ModelToolSpec;
}

export type LoopResult =
	| { answer: string; kind: "answer"; rounds: number }
	| { kind: "over-budget"; rounds: number; verdict: Verdict }
	| { kind: "turn-rejected"; rejection: ToolRejection; rounds: number };

export interface LoopOptions {
	budgets: LoopBudgets;
	/** `tool`: refused calls become tool errors and the turn continues. `turn`: the whole turn is rejected. */
	enforcement: "tool" | "turn";
	model: ModelConnection;
	systemPrompt?: string | undefined;
	tools: GovernedLoopTool[];
}

export async function runGovernedLoop(prompt: string, options: LoopOptions): Promise<LoopResult> {
	const started = Date.now();
	const toolByName = new Map(options.tools.map((tool) => [tool.spec.name, tool]));
	const messages: ModelMessage[] = [];
	if (options.systemPrompt) {
		messages.push({ content: options.systemPrompt, role: "system" });
	}
	messages.push({ content: prompt, role: "user" });

	let rounds = 0;
	for (;;) {
		const overBudget = budgetExceeded(rounds, started, options.budgets);
		if (overBudget) {
			return overBudget;
		}

		// biome-ignore lint/performance/noAwaitInLoops: model rounds are sequential by protocol
		const reply = await options.model.complete({
			messages,
			tools: options.tools.map((tool) => tool.spec),
		});
		rounds += 1;

		if (reply.toolCalls.length === 0) {
			return { answer: reply.text, kind: "answer", rounds };
		}

		messages.push(assistantMessage(reply));
		const rejection = await dispatchToolCalls(
			reply.toolCalls,
			messages,
			toolByName,
			options.enforcement,
		);
		if (rejection) {
			return { kind: "turn-rejected", rejection, rounds };
		}
	}
}

function budgetExceeded(
	rounds: number,
	started: number,
	budgets: LoopBudgets,
): { kind: "over-budget"; rounds: number; verdict: Verdict } | undefined {
	let overBudget: { kind: "over-budget"; rounds: number; verdict: Verdict } | undefined;
	if (rounds >= budgets.maxToolRounds || Date.now() - started >= budgets.maxComputeMs) {
		overBudget = { kind: "over-budget", rounds, verdict: "block" };
	}
	return overBudget;
}

function assistantMessage(reply: ModelReply): ModelMessage {
	return {
		content: reply.text,
		role: "assistant",
		toolCalls: reply.toolCalls.map((call) => ({
			function: { arguments: call.arguments, name: call.name },
			id: call.id,
			type: "function" as const,
		})),
	};
}

async function dispatchToolCalls(
	toolCalls: ModelReply["toolCalls"],
	messages: ModelMessage[],
	toolByName: Map<string, GovernedLoopTool>,
	enforcement: "tool" | "turn",
): Promise<ToolRejection | undefined> {
	let turnRejection: ToolRejection | undefined;
	for (const call of toolCalls) {
		const tool = toolByName.get(call.name);
		if (!tool) {
			messages.push({
				content: definedRejection({ control: "tool-catalog", kind: "blocked", verdict: "block" }),
				name: call.name,
				role: "tool",
				toolCallId: call.id,
			});
			continue;
		}

		// biome-ignore lint/performance/noAwaitInLoops: tool calls run in order, each governed
		const outcome = await tool.execute(parseJsonOrEmpty(call.arguments));
		if (outcome.kind === "confirmation-required") {
			messages.push({
				content: definedConfirmation(outcome.confirmation),
				name: call.name,
				role: "tool",
				toolCallId: call.id,
			});
			continue;
		}
		if (outcome.kind === "refused") {
			if (enforcement === "turn") {
				turnRejection = outcome.rejection;
				break;
			}
			messages.push({
				content: definedRejection(outcome.rejection),
				name: call.name,
				role: "tool",
				toolCallId: call.id,
			});
			continue;
		}

		messages.push({
			content: JSON.stringify(outcome.result ?? null),
			name: call.name,
			role: "tool",
			toolCallId: call.id,
		});
	}
	return turnRejection;
}
