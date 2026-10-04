import { createFileRoute } from "@tanstack/react-router";

import { getHubStatus } from "#/hub/runtime.ts";

/**
 * Tier status (`GET /api/status`): which defenses are live — signature feed
 * health and version, policy profile and version, and whether the JEV
 * semantic tier is enabled. Carries no user content, so pages call it
 * keyless; use it to explain verdicts (e.g. why nothing fired the
 * semantic tier).
 */

export const Route = createFileRoute("/api/status")({
	server: {
		handlers: {
			GET: () => getHubStatus().then((status) => Response.json(status)),
		},
	},
});
