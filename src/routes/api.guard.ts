import { createFileRoute } from "@tanstack/react-router";
import { handleGuardRequest } from "#/control/guard-api.ts";
import { getHub } from "#/hub/runtime.ts";

/**
 * Generic guard API (`POST /api/guard`): resolves caller identity from
 * `x-user-id` / `x-user-group-id`, validates the interaction envelope, routes
 * it through the shared control pipeline, and answers with the defined verdict
 * shapes. Malformed requests are rejected before any control runs.
 */

async function handle(request: Request): Promise<Response> {
	const hub = await getHub();
	return handleGuardRequest(request, {
		audit: hub.audit,
		identity: hub.identity,
		pipeline: hub.pipeline,
	});
}

export const Route = createFileRoute("/api/guard")({
	server: {
		handlers: {
			POST: ({ request }) => handle(request),
		},
	},
});
