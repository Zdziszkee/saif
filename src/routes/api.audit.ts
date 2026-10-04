import { createFileRoute } from "@tanstack/react-router";

import { createGatewayStore } from "#/db/repositories.ts";
import type { GatewayStore } from "#/gateway/store.ts";

/**
 * Dashboard polling endpoint (`GET /api/audit`): answers
 * `?since=<id>&limit=<n>` with `{ events, usage }` rows newer than `since`
 * (exclusive, by row id), each list ordered ascending and capped. Every row
 * carries `id` and `ts` (unix seconds) for cursor tracking.
 *
 * The production store is resolved lazily so tests can import the handler
 * with a fake or in-memory store without a `DATABASE_URL`.
 */

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const MIN_CURSOR = 0;
const MIN_LIMIT = 1;
const RADIX_DECIMAL = 10;

function parseCursor(raw: string | null): number | null {
	if (raw === null || raw === "") {
		return MIN_CURSOR;
	}
	const parsed = Number.parseInt(raw, RADIX_DECIMAL);
	if (!Number.isInteger(parsed) || parsed < MIN_CURSOR) {
		return null;
	}
	return parsed;
}

function parseLimit(raw: string | null): number | null {
	if (raw === null || raw === "") {
		return DEFAULT_LIMIT;
	}
	const parsed = Number.parseInt(raw, RADIX_DECIMAL);
	if (!Number.isInteger(parsed) || parsed < MIN_LIMIT) {
		return null;
	}
	return Math.min(parsed, MAX_LIMIT);
}

export async function handleAuditPoll(request: Request, store?: GatewayStore): Promise<Response> {
	const url = new URL(request.url);
	const cursor = parseCursor(url.searchParams.get("since"));
	const limit = parseLimit(url.searchParams.get("limit"));
	if (cursor === null || limit === null) {
		return Response.json({ error: "malformed_request" }, { status: 400 });
	}
	const active = store ?? createGatewayStore((await import("#/db/index.ts")).db);
	const result = await active.poll(cursor, limit);
	return Response.json({ events: result.events, usage: result.usage });
}

export const Route = createFileRoute("/api/audit")({
	server: {
		handlers: {
			GET: ({ request }) => handleAuditPoll(request),
		},
	},
});
