import { createFileRoute } from "@tanstack/react-router";

import { readAuditEvents, summarizeAuditDecisions } from "#/control/audit.ts";
import { getAuditSink } from "#/hub/runtime.ts";

const RECENT_LIMIT = 20;

/**
 * Keyless dashboard data (`GET /api/decisions`): decision counts and recent
 * rows only — no user content beyond what the dashboard already renders.
 * Route loaders execute in the browser on client-side navigation, so pages
 * must not read node-backed state from loaders; they fetch server handlers
 * like this one instead. (The bulk JSONL/CSV audit export stays
 * consumer-key-gated.)
 */

export const Route = createFileRoute("/api/decisions")({
	server: {
		handlers: {
			GET: () =>
				Response.json(summarizeAuditDecisions(readAuditEvents(getAuditSink()), RECENT_LIMIT)),
		},
	},
});
