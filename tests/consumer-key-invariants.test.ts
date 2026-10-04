/**
 * Cross-cutting consumer-key invariants: the contract doc for future
 * unification work. The read paths agree on explicit keys but diverge on how
 * they label a keyless event, so each label below pins its ACTUAL behavior
 * rather than the desired one — do not "fix" these in src from here.
 *
 * Keyless-label evidence table (all asserted below):
 *
 * | Producer                              | Missing-key label | Shape              |
 * | ------------------------------------- | ----------------- | ------------------ |
 * | `summarizeAuditDecisions` (byConsumer)| `"none"`          | no parens          |
 * | recorders (`guardInteraction`, seams) | `"(none)"`        | `key ?? "(none)"`  |
 * | `consumerKeyOf` fallback              | `"(none)"`        | `UNKNOWN_CONSUMER` |
 */
import { describe, expect, test } from "bun:test";

import {
	consumerKeyOf,
	filterByConsumerKey,
	UNKNOWN_CONSUMER,
} from "#/components/dashboard-consumers.ts";
import {
	type AuditEvent,
	auditEvent,
	createInMemoryAuditSink,
	filterAuditEvents,
	summarizeAuditDecisions,
} from "#/control/audit.ts";
import { guardInteraction } from "#/control/guard.ts";
import { createConsumerResolver } from "#/control/subjects.ts";
import type { ControlPipeline, Interaction } from "#/control/types.ts";

const seed: AuditEvent[] = [
	{
		consumerKey: "alice",
		controlId: "deterministic",
		kind: "interaction",
		subject: "alice",
		timestamp: "2026-01-01T00:00:00.000Z",
		verdict: "allow",
	},
	{
		consumerKey: "bob",
		controlId: "deterministic",
		kind: "interaction",
		subject: "bob",
		timestamp: "2026-01-02T00:00:00.000Z",
		verdict: "block",
	},
	{
		// No dedicated key: the policy subject carries the attribution.
		controlId: "signatures",
		kind: "interaction",
		subject: "alice",
		timestamp: "2026-01-03T00:00:00.000Z",
		verdict: "redact",
	},
];

const allowPipeline: ControlPipeline = {
	inspect: () =>
		Promise.resolve({
			content: "hello world",
			flagged: false,
			hits: [],
			redactions: [],
			verdict: "allow",
		}),
};

const keylessInteraction: Interaction = {
	content: "hello world",
	direction: "inbound",
	id: "invariant-fixture",
	seam: "guard-api",
	subject: "default",
};

describe("consumer filter parity", () => {
	test("explicit keys select the same events in the export and dashboard filters", () => {
		expect(filterByConsumerKey(seed, "bob")).toEqual(
			filterAuditEvents(seed, { consumerKey: "bob" }),
		);
	});

	test("subject-fallback events match the dashboard filter but not the export filter", () => {
		// Known divergence: filterByConsumerKey resolves via consumerKeyOf (key,
		// then subject, then "(none)"), while filterAuditEvents matches the raw
		// consumerKey field exactly. Unification must decide one rule.
		expect(filterByConsumerKey(seed, "alice")).toHaveLength(2);
		expect(filterAuditEvents(seed, { consumerKey: "alice" })).toHaveLength(1);
	});
});

describe("keyless-consumer labels", () => {
	test('summarizeAuditDecisions labels a missing key as "none"', () => {
		expect(summarizeAuditDecisions(seed).byConsumer).toContainEqual(["none", 1]);
	});

	test('recorders persist a missing key as "(none)" beside the resolved subject', async () => {
		const sink = createInMemoryAuditSink();

		await guardInteraction(keylessInteraction, allowPipeline, { audit: sink });

		expect(sink.events).toHaveLength(1);
		expect(sink.events[0]?.consumerKey).toBe("(none)");
		expect(sink.events[0]?.subject).toBe("default");
	});

	test('consumerKeyOf falls back to "(none)" without a key or subject', () => {
		expect(consumerKeyOf({ ...auditEvent("interaction"), subject: undefined })).toBe("(none)");
	});

	test('the unknown-consumer marker is "(none)"', () => {
		expect(UNKNOWN_CONSUMER).toBe("(none)");
	});

	test("an empty recorded key falls back to the subject", () => {
		const event = {
			...auditEvent("interaction", { subject: "alice", verdict: "allow" }),
			consumerKey: "",
		};

		expect(consumerKeyOf(event)).toBe("alice");
	});
});

describe("audit time-range inclusivity", () => {
	test("since includes events exactly on the boundary", () => {
		const window = filterAuditEvents(seed, { since: "2026-01-02T00:00:00.000Z" });

		expect(window).toHaveLength(2);
		expect(window[0]?.timestamp).toBe("2026-01-02T00:00:00.000Z");
	});

	test("until includes events exactly on the boundary", () => {
		const window = filterAuditEvents(seed, { until: "2026-01-02T00:00:00.000Z" });

		expect(window).toHaveLength(2);
		expect(window.at(-1)?.timestamp).toBe("2026-01-02T00:00:00.000Z");
	});
});

describe("subject equals key for known keys", () => {
	test("a known key resolves to a subject of the same name", () => {
		const resolver = createConsumerResolver({
			defaultSubject: "default",
			knownKeys: ["alice"],
			unknownKey: "default-subject",
		});

		const resolution = resolver.resolve("alice");
		expect(resolution.ok).toBe(true);
		if (resolution.ok) {
			expect(resolution.subject).toBe("alice");
		}
	});

	test("a recorded known-key decision carries identical consumerKey and subject", async () => {
		const sink = createInMemoryAuditSink();

		await guardInteraction({ ...keylessInteraction, subject: "alice" }, allowPipeline, {
			audit: sink,
			consumerKey: "alice",
		});

		expect(sink.events).toHaveLength(1);
		expect(sink.events[0]?.consumerKey).toBe("alice");
		expect(sink.events[0]?.subject).toBe("alice");
	});
});
