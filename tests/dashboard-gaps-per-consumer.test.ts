import { describe, expect, it } from "bun:test";

import { selectEscalations } from "#/components/dashboard-meta.ts";
import {
	type AuditEvent,
	auditEvent,
	auditEventsToCsv,
	auditEventsToJsonl,
	createInMemoryAuditSink,
	filterAuditEvents,
	readAuditEvents,
	summarizeAuditDecisions,
} from "#/control/audit.ts";

/**
 * Dashboard gap coverage: per-consumer tracking at shape level.
 *
 * Seeds decisions across 3 consumer keys x 4 verdicts with fixed timestamps
 * and locks the end-to-end contract: `summarizeAuditDecisions` exposes
 * `byConsumer`, `filterAuditEvents` slices by `consumerKey`, every recent row
 * carries the key, and the JSONL/CSV exports preserve filter parity. The
 * `subject` assertions pin the pre-existing invariant (known keys govern as a
 * subject of the same name; see `src/control/subjects.ts`) alongside the
 * dedicated `consumerKey` field.
 */

const CONSUMERS: readonly string[] = ["alice", "bob", "deploy-bot"];
const VERDICTS = ["allow", "block", "redact", "escalate"] as const;

function stamp(day: number): string {
	return `2026-05-${String(day).padStart(2, "0")}T00:00:00.000Z`;
}

function seedDecisions() {
	const sink = createInMemoryAuditSink();
	const controls = ["deterministic", "signatures", "semantic", "deterministic"] as const;
	let day = 1;
	for (const consumerKey of CONSUMERS) {
		for (const [index, verdict] of VERDICTS.entries()) {
			sink.record({
				...auditEvent("interaction", {
					consumerKey,
					controlId: controls[index] ?? "deterministic",
					interactionId: `${consumerKey}-${verdict}`,
					seam: "guard-api",
					subject: consumerKey,
					verdict,
				}),
				timestamp: stamp(day),
			});
			day += 1;
		}
	}
	// Noise the dashboard must ignore: verdict-less info note + non-interaction kind.
	sink.record({
		...auditEvent("interaction", { consumerKey: "alice", subject: "alice" }),
		timestamp: stamp(day),
	});
	day += 1;
	sink.record({
		...auditEvent("registration", {
			consumerKey: "bob",
			subject: "bob",
			verdict: "allow",
		}),
		timestamp: stamp(day),
	});
	return sink;
}

describe("dashboard per-consumer gaps", () => {
	it("tracks aggregate totals across all consumers", () => {
		const summary = summarizeAuditDecisions(readAuditEvents(seedDecisions()));
		expect(summary.total).toBe(12);
		for (const verdict of VERDICTS) {
			expect(summary.byVerdict.find(([name]) => name === verdict)).toEqual([verdict, 3]);
		}
	});

	it("exposes a by-consumer breakdown on the summary", () => {
		const summary = summarizeAuditDecisions(readAuditEvents(seedDecisions()));
		expect(summary.byConsumer).toEqual([
			["alice", 4],
			["bob", 4],
			["deploy-bot", 4],
		]);
	});

	it("slices verdict counts per consumer via the consumerKey filter", () => {
		const events = readAuditEvents(seedDecisions());
		for (const consumer of CONSUMERS) {
			const sliced = filterAuditEvents(events, { consumerKey: consumer });
			const summary = summarizeAuditDecisions(sliced);
			expect(summary.total).toBe(4);
			expect(new Set(summary.recent.map((event) => event.consumerKey))).toEqual(
				new Set([consumer]),
			);
		}
	});

	it("derives a per-consumer by-verdict breakdown", () => {
		const events = readAuditEvents(seedDecisions());
		const alice = summarizeAuditDecisions(filterAuditEvents(events, { consumerKey: "alice" }));
		expect(alice.byVerdict).toHaveLength(4);
		for (const [, count] of alice.byVerdict) {
			expect(count).toBe(1);
		}
	});

	it("combines consumerKey with verdict to isolate one row", () => {
		const events = readAuditEvents(seedDecisions());
		const bobBlocks = filterAuditEvents(events, { consumerKey: "bob", verdict: "block" });
		expect(bobBlocks).toHaveLength(1);
		expect(summarizeAuditDecisions(bobBlocks).total).toBe(1);
	});

	it("carries the consumer identity on every recent row", () => {
		const summary = summarizeAuditDecisions(readAuditEvents(seedDecisions()), 20);
		expect(summary.recent).toHaveLength(12);
		for (const row of summary.recent) {
			const key: string | undefined = row.consumerKey;
			expect(key).toBeDefined();
			if (key !== undefined) {
				expect(CONSUMERS).toContain(key);
			}
			expect(row.subject).toBe(row.consumerKey);
		}
	});

	it("orders recent rows newest first", () => {
		const summary = summarizeAuditDecisions(readAuditEvents(seedDecisions()), 20);
		expect(summary.recent[0]?.interactionId).toBe("deploy-bot-escalate");
		expect(summary.recent.at(-1)?.interactionId).toBe("alice-allow");
	});

	it("keeps export filter parity with the dashboard slice", () => {
		const events = readAuditEvents(seedDecisions());
		const filtered = filterAuditEvents(events, {
			consumerKey: "deploy-bot",
			verdict: "escalate",
		});
		expect(filtered).toHaveLength(1);
		expect(auditEventsToJsonl(filtered).split("\n")).toHaveLength(1);
		const csv = auditEventsToCsv(filtered).split("\n");
		expect(csv).toHaveLength(2);
		expect(csv[0]).toContain("consumerKey");
		expect(csv[1]).toContain("deploy-bot");
	});

	it("keeps filter, summary, and serializers in agreement", () => {
		const events = readAuditEvents(seedDecisions());
		const filtered = filterAuditEvents(events, { consumerKey: "alice" });
		// The filter keeps the verdict-less note; the summary counts decisions only.
		expect(filtered).toHaveLength(5);
		const summary = summarizeAuditDecisions(filtered);
		expect(summary.total).toBe(4);
		const lines = auditEventsToJsonl(filtered).split("\n");
		const rows = auditEventsToCsv(filtered).split("\n");
		expect(lines).toHaveLength(filtered.length);
		expect(rows).toHaveLength(filtered.length + 1);
		for (const [index, line] of lines.entries()) {
			expect((JSON.parse(line) as AuditEvent).consumerKey).toBe("alice");
			expect(rows[index + 1] ?? "").toContain("alice");
		}
	});

	it("derives the escalation queue as verdict==escalate decisions", () => {
		const events = readAuditEvents(seedDecisions());
		const escalations = filterAuditEvents(events, { verdict: "escalate" });
		expect(escalations).toHaveLength(3);
		expect(new Set(escalations.map((event) => event.consumerKey))).toEqual(new Set(CONSUMERS));
	});

	it("scopes the escalation queue per consumer", () => {
		const events = readAuditEvents(seedDecisions());
		const alice = selectEscalations(events, 20, "alice");
		expect(alice).toHaveLength(1);
		expect(alice[0]?.consumerKey).toBe("alice");
		expect(selectEscalations(events, 20, "carol")).toEqual([]);
	});
});
