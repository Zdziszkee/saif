import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createFileRoute } from "@tanstack/react-router";
import z from "zod";
import { addTodo } from "#/mcp-todos.ts";
import { handleMcpRequest } from "#/utils/mcp-handler.ts";

const server = new McpServer({
	name: "start-server",
	version: "1.0.0",
});

server.registerTool(
	"addTodo",
	{
		description: "Add a todo to a list of todos",
		inputSchema: {
			title: z.string().describe("The title of the todo"),
		},
		title: "Tool to add a todo to a list of todos",
	},
	({ title }) => ({
		content: [{ text: String(addTodo(title)), type: "text" }],
	}),
);

// server.registerResource(
//   "counter-value",
//   "count://",
//   {
//     title: "Counter Resource",
//     description: "Returns the current value of the counter",
//   },
//   async (uri) => {
//     return {
//       contents: [
//         {
//           uri: uri.href,
//           text: `The counter is at 20!`,
//         },
//       ],
//     };
//   }
// );

export const Route = createFileRoute("/mcp")({
	server: {
		handlers: {
			POST: async ({ request }) => handleMcpRequest(request, server),
		},
	},
});
