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
							// The gate is identity-based, but the denial keeps per-key
							// attribution: the identity model removed the consumer-key
							// helper, so read the raw header inline. `||` is
							// deliberate: both a missing header (`null`) and an
							// empty one (`""`) mean "no key presented".
							consumerKey: request.headers.get("x-consumer-key") || "(none)",
							controlId: "consumer-key",
							detail: `audit export denied: ${access.reason}`,
							groupId: "export",
						}),
					);
					return Response.json({ error: "rejected", reason: access.reason }, { status: 403 });
				}
				const url = new URL(request.url);
				const param = (name: string): string | undefined => url.searchParams.get(name) ?? undefined;
				const format = param("format") ?? "jsonl";
				if (format !== "jsonl" && format !== "csv") {
					return Response.json(
						{ error: "invalid_request", reason: 'format must be "jsonl" or "csv"' },
						{ status: 400 },
					);
				}
				const sink = getAuditSink();
				const events = readAuditEvents(sink);
				const consumer = param("consumer") ?? param("consumerKey");
				const user = param("user") ?? param("userId");
				const filtered = filterAuditEvents(events, {
					consumerKey: consumer,
					control: param("control"),
					groupId: param("groupId"),
					since: param("since"),
					until: param("until"),
					userId: user,
					verdict: param("verdict"),
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
