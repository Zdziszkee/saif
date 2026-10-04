import { createFileRoute } from "@tanstack/react-router";
import { identityFromRequest, identityRejection } from "#/control/subjects.ts";
import { getHub } from "#/hub/runtime.ts";

/**
 * The MCP safety hub surface, served over standard MCP protocol (HTTP) via
 * `createMCPServer` from `@tanstack/ai-mcp/server`. Any standards-compliant
 * MCP client can connect, enumerate the governed tool catalog, and invoke
 * tools; every call is subject to the same tool-call governance.
 *
 * Caller identity comes from `x-user-id` / `x-user-group-id`: the group is the
 * policy subject that selects the profile and the applicable control set.
 */

async function handle(request: Request): Promise<Response> {
	const hub = await getHub();
	const presented = identityFromRequest(request);
	const resolution = hub.identity.resolve(presented.userId, presented.groupId);

	if (!resolution.ok) {
		return identityRejection(resolution, hub.audit);
	}

	return hub.server(resolution.identity.groupId).fetch(request);
}

export const Route = createFileRoute("/mcp")({
	server: {
		handlers: {
			DELETE: ({ request }) => handle(request),
			GET: ({ request }) => handle(request),
			POST: ({ request }) => handle(request),
		},
	},
});
