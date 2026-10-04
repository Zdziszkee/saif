import { createFileRoute } from "@tanstack/react-router";

import {
	auditEvent,
	auditEventsToCsv,
	auditEventsToJsonl,
	filterAuditEvents,
	readAuditEvents,
} from "#/control/audit.ts";
import { requireKnownGroup } from "#/control/subjects.ts";
import { getAuditSink, getHub } from "#/hub/runtime.ts";

export const Route = createFileRoute("/api/audit/export")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const hub = await getHub();
				const access = requireKnownGroup(request, hub.identity);
				if (!access.ok) {
					hub.audit.record(
						auditEvent("interaction", {
							controlId: "consumer-key",
							detail: `audit export denied: ${access.reason}`,
							groupId: "export",
						}),
					);
					return Response.json({ error: "rejected", reason: access.reason }, { status: 403 });
				}
				const url = new URL(request.url);
				const format = url.searchParams.get("format") ?? "jsonl";
				if (format !== "jsonl" && format !== "csv") {
					return Response.json(
						{ error: "invalid_request", reason: 'format must be "jsonl" or "csv"' },
						{ status: 400 },
					);
				}
				const sink = getAuditSink();
				const events = readAuditEvents(sink);
				const filtered = filterAuditEvents(events, {
					control: url.searchParams.get("control") ?? undefined,
					groupId: url.searchParams.get("groupId") ?? undefined,
					verdict: url.searchParams.get("verdict") ?? undefined,
				});
				const body = format === "csv" ? auditEventsToCsv(filtered) : auditEventsToJsonl(filtered);
				return new Response(body, {
					headers: {
						"content-disposition": `attachment; filename="audit.${format}"`,
						"content-type": format === "csv" ? "text/csv" : "application/jsonl",
					},
				});
			},
		},
	},
});
