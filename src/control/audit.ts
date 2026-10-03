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
	interactionId?: string | undefined;
	kind: AuditEventKind;
	redactionCount?: number | undefined;
	seam?: string | undefined;
	subject?: string | undefined;
	timestamp: string;
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

export interface AuditFilter {
	control?: string | undefined;
	subject?: string | undefined;
	verdict?: string | undefined;
}

/** Append-only query: filter recorded events without mutating the sink. */
export function filterAuditEvents(
	events: readonly AuditEvent[],
	filter: AuditFilter,
): AuditEvent[] {
	return events.filter(
		(event) =>
			(filter.verdict === undefined || event.verdict === filter.verdict) &&
			(filter.control === undefined || event.controlId === filter.control) &&
			(filter.subject === undefined || event.subject === filter.subject),
	);
}

const CSV_COLUMNS = [
	"timestamp",
	"kind",
	"verdict",
	"controlId",
	"subject",
	"seam",
	"interactionId",
	"detail",
	"redactionCount",
] as const;

const CSV_NEEDS_QUOTES = /[",\n]/;

function csvCell(value: unknown): string {
	const text = value === undefined || value === null ? "" : String(value);
	return CSV_NEEDS_QUOTES.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

/** One JSON object per line, parseable by standard JSONL tooling. */
export function auditEventsToJsonl(events: readonly AuditEvent[]): string {
	return events.map((event) => JSON.stringify(event)).join("\n");
}

/** Header row plus one row per event, RFC 4180 quoting. */
export function auditEventsToCsv(events: readonly AuditEvent[]): string {
	const header = CSV_COLUMNS.join(",");
	const rows = events.map((event) => CSV_COLUMNS.map((column) => csvCell(event[column])).join(","));
	return [header, ...rows].join("\n");
}
