import { createFileRoute } from "@tanstack/react-router";

import { auditEventsToCsv, auditEventsToJsonl, filterAuditEvents } from "#/control/audit.ts";
import { getAuditSink } from "#/hub/runtime.ts";

export const Route = createFileRoute("/api/audit/export")({
	server: {
		handlers: {
			GET: ({ request }) => {
				const url = new URL(request.url);
				const format = url.searchParams.get("format") ?? "jsonl";
				if (format !== "jsonl" && format !== "csv") {
					return Response.json(
						{ error: "invalid_request", reason: 'format must be "jsonl" or "csv"' },
						{ status: 400 },
					);
				}
				const sink = getAuditSink();
				const events = "events" in sink && Array.isArray(sink.events) ? sink.events : [];
				const filtered = filterAuditEvents(events, {
					control: url.searchParams.get("control") ?? undefined,
					subject: url.searchParams.get("subject") ?? undefined,
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
