/**
 * Audit seam. The gateway and the hub record every governance decision here.
 *
 * The durable append-only audit store (SQLite-backed, exportable) lives in the
 * security-observability spec module; until then the sink interface is the
 * boundary and the in-memory sink backs tests and observe-only wiring.
 */

import type { Verdict } from "./types.ts";

export type AuditEventKind = "budget" | "connection" | "failure" | "interaction" | "registration";

export interface AuditEvent {
	/** Control responsible for the verdict, when one is attributable. */
	controlId?: string | undefined;
	detail?: string | undefined;
	/** Policy subject: the user group the caller presented. */
	groupId?: string | undefined;
	interactionId?: string | undefined;
	kind: AuditEventKind;
	redactionCount?: number | undefined;
	seam?: string | undefined;
	timestamp: string;
	/** The individual caller, when attributable. */
	userId?: string | undefined;
	verdict?: Verdict | undefined;
}

export interface AuditSink {
	record(event: AuditEvent): void;
}

export const noopAuditSink: AuditSink = {
	record: () => undefined,
};

export function createInMemoryAuditSink(): AuditSink & { events: AuditEvent[] } {
	const events: AuditEvent[] = [];
	return {
		events,
		record: (event) => {
			events.push(event);
		},
	};
}

export function auditEvent(
	kind: AuditEventKind,
	fields: Omit<AuditEvent, "kind" | "timestamp"> = {},
): AuditEvent {
	return { ...fields, kind, timestamp: new Date().toISOString() };
}
