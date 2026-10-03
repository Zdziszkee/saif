/**
 * Hub-hosted tool specifications (MCP safety hub requirement).
 *
 * The catalog includes ordinary tools (todo management) and demonstration
 * risky tools (`fetchUrl`, `deleteAllTodos`) so governance of network and
 * destructive calls is visible. `askModel` is the only model-reaching tool
 * and is assembled by the hub. The catalog is the single source for both the
 * MCP surface and the governed agentic loop, so the two cannot drift.
 */

import { z } from "zod";
import { addTodo, clearTodos, getTodos } from "#/mcp-todos.ts";
import type { ToolImplementation } from "./catalog.ts";

const FETCH_BODY_LIMIT_CHARS = 20_000;

export const askModelInputSchema = z.object({ prompt: z.string().min(1) });

export const askModelOutputSchema = z.object({
	answer: z.string(),
	control: z.string(),
	status: z.enum(["blocked", "escalated", "failed", "ok", "over-budget"]),
	verdict: z.enum(["allow", "redact", "block", "escalate"]),
});

export type AskModelResult = z.infer<typeof askModelOutputSchema>;

export const askModelName = "askModel";

export const askModelDescription =
	"Send a prompt to the governed model connection and return its answer. " +
	"The only path from clients to the model: the prompt and the answer are " +
	"inspected by the control pipeline before forwarding.";

export interface BuiltinToolSpec {
	description: string;
	implementation: ToolImplementation;
	inputSchema: z.ZodType;
	name: string;
}

export const basicBuiltinTools: BuiltinToolSpec[] = [
	{
		description: "Add a todo to a list of todos",
		implementation: (args) => {
			const { title } = args as { title: string };
			return addTodo(title);
		},
		inputSchema: z.object({ title: z.string().min(1) }),
		name: "addTodo",
	},
	{
		description:
			"DESTRUCTIVE DEMO TOOL: delete every todo. Runs only under tool-call " +
			"governance; kept in the catalog to demonstrate risky-tool control.",
		implementation: () => ({ deleted: clearTodos() }),
		inputSchema: z.object({}),
		name: "deleteAllTodos",
	},
	{
		description:
			"RISKY DEMO TOOL: fetch a URL over the network and return its text body. " +
			"Runs only under tool-call governance; kept in the catalog to demonstrate " +
			"network-tool control.",
		implementation: async (args) => {
			const { url } = args as { url: string };
			const response = await fetch(url);
			return {
				body: (await response.text()).slice(0, FETCH_BODY_LIMIT_CHARS),
				status: response.status,
			};
		},
		inputSchema: z.object({ url: z.string().url() }),
		name: "fetchUrl",
	},
	{
		description: "List the current todos",
		implementation: () => ({ todos: getTodos() }),
		inputSchema: z.object({}),
		name: "listTodos",
	},
];
