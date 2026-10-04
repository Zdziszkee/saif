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

/** Fan-out sink: every recorded event goes to each sink in order. */
export function combineAuditSinks(...sinks: AuditSink[]): AuditSink {
	return {
		record: (event) => {
			for (const sink of sinks) {
				sink.record(event);
			}
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

/**
 * Whether an event is a user-facing governance decision: exactly one is
 * recorded per `guardInteraction()` call. Registration admissions, control
 * failures, and verdict-less info notes (e.g. consumer-key resolution) live in
 * the same sink for the security export but are not decisions — counting them
 * is what made one guard call show up as several dashboard rows.
 */
export function isAuditDecision(event: { kind?: string; verdict?: unknown }): boolean {
	return event.kind === "interaction" && event.verdict !== undefined;
}

/**
 * Typed read of an audit sink's recorded events. Sinks expose `events` only
 * by convention (the interface is append-only), so this is the one place
 * that duck-types the access instead of every consumer doing it inline.
 */
export function readAuditEvents(sink: AuditSink): readonly AuditEvent[] {
	if ("events" in sink) {
		const { events } = sink as { events?: unknown };
		if (Array.isArray(events)) {
			return events as AuditEvent[];
		}
	}
	return [];
}

export interface AuditDecisionSummary {
	byControl: [string, number][];
	byVerdict: [string, number][];
	recent: AuditEvent[];
	total: number;
}

/**
 * Dashboard shaping over the sink: counts and recent rows cover decisions
 * only (see {@link isAuditDecision}), newest first, capped at `recentLimit`.
 */
export function summarizeAuditDecisions(
	events: readonly AuditEvent[],
	recentLimit = 20,
): AuditDecisionSummary {
	const decisions = events.filter(isAuditDecision);
	const byCount = (key: (event: AuditEvent) => string): [string, number][] => {
		const counts = new Map<string, number>();
		for (const event of decisions) {
			const label = key(event);
			counts.set(label, (counts.get(label) ?? 0) + 1);
		}
		return [...counts.entries()].sort((a, b) => b[1] - a[1]);
	};
	return {
		byControl: byCount((event) => event.controlId ?? "none"),
		byVerdict: byCount((event) => event.verdict ?? "none"),
		recent: decisions.slice(-recentLimit).reverse(),
		total: decisions.length,
	};
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
