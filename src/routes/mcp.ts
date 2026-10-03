import { createFileRoute } from "@tanstack/react-router";
import { auditEvent } from "#/control/audit.ts";
import { consumerKeyFromRequest } from "#/control/subjects.ts";
import { getHub } from "#/hub/runtime.ts";

/**
 * The MCP safety hub surface, served over standard MCP protocol (HTTP) via
 * `createMCPServer` from `@tanstack/ai-mcp/server`. Any standards-compliant
 * MCP client can connect, enumerate the governed tool catalog, and invoke
 * tools; every call is subject to the same tool-call governance. The consumer
 * key header identifies the policy subject the caller acts as (multi-consumer
 * connections).
 */

async function handle(request: Request): Promise<Response> {
	const hub = await getHub();
	const resolution = hub.consumers.resolve(consumerKeyFromRequest(request));

	if (!resolution.ok) {
		hub.audit.record(
			auditEvent("interaction", {
				controlId: "consumer-key",
				detail: `consumer key rejected: ${resolution.reason}`,
				verdict: "block",
			}),
		);
		return Response.json(
			{
				control: "consumer-key",
				error: "rejected",
				reason: resolution.reason,
				verdict: "block",
			},
			{ status: 403 },
		);
	}
	if (resolution.kind === "default-subject") {
		hub.audit.record(
			auditEvent("interaction", {
				detail: `consumer key resolved to default subject: ${resolution.key ?? "(none)"}`,
				subject: resolution.subject,
			}),
		);
	}

	return hub.server(resolution.subject).fetch(request);
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
