/**
 * Hub-hosted tool specifications (MCP safety hub requirement).
 *
 * The catalog includes ordinary tools (todo management) and demonstration
 * risky tools (`fetchUrl`, `deleteAllTodos`) so governance of network and
 * destructive calls is visible. The catalog is tools-only (design D10): it is
 * the single source for the MCP surface and for direct governed invocation,
 * and it never contains a model-reaching tool.
 */

import { z } from "zod";
import { addTodo, clearTodos, getTodos } from "#/mcp-todos.ts";
import type { ToolImplementation } from "./catalog.ts";

const FETCH_BODY_LIMIT_CHARS = 20_000;

export interface BuiltinToolSpec {
	description: string;
	implementation: ToolImplementation;
	inputSchema: z.ZodType;
	name: string;
}

const addTodoInput = z.object({ title: z.string().min(1) });
const emptyInput = z.object({});
const fetchUrlInput = z.object({ url: z.string().url() });

export const basicBuiltinTools: BuiltinToolSpec[] = [
	{
		description: "Add a todo to a list of todos",
		implementation: (args) => {
			const { title } = addTodoInput.parse(args);
			return addTodo(title);
		},
		inputSchema: addTodoInput,
		name: "addTodo",
	},
	{
		description:
			"DESTRUCTIVE DEMO TOOL: delete every todo. Runs only under tool-call " +
			"governance; kept in the catalog to demonstrate risky-tool control.",
		implementation: () => ({ deleted: clearTodos() }),
		inputSchema: emptyInput,
		name: "deleteAllTodos",
	},
	{
		description:
			"RISKY DEMO TOOL: fetch a URL over the network and return its text body. " +
			"Runs only under tool-call governance; kept in the catalog to demonstrate " +
			"network-tool control.",
		implementation: async (args) => {
			const { url } = fetchUrlInput.parse(args);
			const response = await fetch(url);
			return {
				body: (await response.text()).slice(0, FETCH_BODY_LIMIT_CHARS),
				status: response.status,
			};
		},
		inputSchema: fetchUrlInput,
		name: "fetchUrl",
	},
	{
		description: "List the current todos",
		implementation: () => ({ todos: getTodos() }),
		inputSchema: emptyInput,
		name: "listTodos",
	},
];
