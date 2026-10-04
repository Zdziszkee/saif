import { describe, expect, it } from "bun:test";

import type { GatewayAuditRow, GatewayUsageRow } from "#/gateway/store.ts";
import { setupIsolatedGatewayStore } from "./helpers/tables.ts";

function setupStore() {
	return setupIsolatedGatewayStore();
}

const EVIDENCE_DETAIL = "prompt_injection=0.91, jailbreak=0.87";
const LONG_DETAIL_REPEAT = 500;
const LONG_EVIDENCE_DETAIL = "prompt_injection=0.91, jailbreak=0.87. ".repeat(LONG_DETAIL_REPEAT);

function auditRow(overrides: Partial<GatewayAuditRow> = {}): GatewayAuditRow {
	return {
		cause: null,
		controlId: null,
		detail: null,
		groupId: "hr",
		model: null,
		policyVersion: "v1",
		promptText: null,
		score: null,
		userId: "alice",
		verdict: "allow",
		...overrides,
	};
}

function usageRow(overrides: Partial<GatewayUsageRow> = {}): GatewayUsageRow {
	return {
		auditEventId: null,
		completionTokens: 50,
		costUsd: 0.05,
		groupId: "hr",
		model: "gpt-test",
		promptTokens: 100,
		userId: "alice",
		...overrides,
	};
}

describe("db repositories", () => {
	it("returns incrementing ids on append", async () => {
		const store = setupStore();
		const first = await store.recordAudit(auditRow());
		const second = await store.recordAudit(auditRow({ verdict: "block" }));
		expect(typeof first).toBe("number");
		expect(second).toBeGreaterThan(first);

		const usageId = await store.recordUsage(usageRow({ auditEventId: first }));
		expect(typeof usageId).toBe("number");
	});

	it("polls rows newer than the cursor in ascending order", async () => {
		const store = setupStore();
		const ids = [
			await store.recordAudit(auditRow()),
			await store.recordAudit(auditRow({ verdict: "block" })),
			await store.recordAudit(auditRow({ verdict: "redact" })),
		];
		const first = ids[0] ?? 0;
		const last = ids.at(-1) ?? 0;

		const all = await store.poll(0, 100);
		expect(all.events.map((event) => event.id)).toEqual(ids);
		for (const event of all.events) {
			expect(typeof event.id).toBe("number");
			expect(typeof event.ts).toBe("number");
		}

		const newer = await store.poll(first, 100);
		expect(newer.events.map((event) => event.id)).toEqual(ids.slice(1));

		const empty = await store.poll(last, 100);
		expect(empty.events).toHaveLength(0);
		expect(empty.usage).toHaveLength(0);
	});

	it("caps each polled list at the limit", async () => {
		const store = setupStore();
		await store.recordAudit(auditRow());
		await store.recordAudit(auditRow());
		await store.recordAudit(auditRow());
		await store.recordUsage(usageRow());
		await store.recordUsage(usageRow());

		const page = await store.poll(0, 2);
		expect(page.events).toHaveLength(2);
		expect(page.usage).toHaveLength(2);
		expect(page.events[0]?.id).toBeLessThan(page.events[1]?.id ?? 0);
	});

	it("sums spend treating unknown-model cost as zero with unpriced detail", async () => {
		const store = setupStore();
		await store.recordUsage(usageRow({ completionTokens: 50, costUsd: 0.05, promptTokens: 100 }));
		await store.recordUsage(
			usageRow({ completionTokens: 100, costUsd: null, model: "unknown-model", promptTokens: 200 }),
		);
		await store.recordUsage(usageRow({ costUsd: 0.02, userId: "bob" }));

		const spend = await store.spendSince("alice", 0);
		expect(spend.costUsd).toBeCloseTo(0.05);
		expect(spend.tokens).toBe(450);

		const detailed = await store.spendSinceDetailed("alice", 0);
		expect(detailed.costUsd).toBeCloseTo(0.05);
		expect(detailed.tokens).toBe(450);
		expect(detailed.unpricedTokens).toBe(300);

		const other = await store.spendSince("bob", 0);
		expect(other.tokens).toBe(150);

		const future = await store.spendSince("alice", Math.floor(Date.now() / 1000) + 3600);
		expect(future).toEqual({ costUsd: 0, tokens: 0, unpricedTokens: 0 });
	});

	it("round-trips unknown-model usage with null cost through poll", async () => {
		const store = setupStore();
		await store.recordUsage(usageRow({ costUsd: null, model: "unknown-model" }));

		const page = await store.poll(0, 100);
		expect(page.usage).toHaveLength(1);
		expect(page.usage[0]?.costUsd).toBeNull();
		expect(page.usage[0]?.model).toBe("unknown-model");
		expect(typeof page.usage[0]?.id).toBe("number");
		expect(typeof page.usage[0]?.ts).toBe("number");
	});

	it("round-trips scored evidence detail through poll", async () => {
		const store = setupStore();
		await store.recordAudit(auditRow());
		await store.recordAudit(
			auditRow({
				controlId: "prompt_injection",
				detail: EVIDENCE_DETAIL,
			}),
		);

		const page = await store.poll(0, 100);
		expect(page.events).toHaveLength(2);
		expect(page.events[0]?.detail).toBeNull();
		expect(page.events[1]?.detail).toBe(EVIDENCE_DETAIL);
		expect(page.events[1]?.controlId).toBe("prompt_injection");
	});

	it("persists null detail as null through poll", async () => {
		const store = setupStore();
		await store.recordAudit(auditRow({ detail: null }));

		const page = await store.poll(0, 100);
		expect(page.events).toHaveLength(1);
		expect(page.events[0]?.detail).toBeNull();
		expect("detail" in (page.events[0] ?? {})).toBe(true);
	});

	it("preserves long evidence text without truncation", async () => {
		const store = setupStore();
		await store.recordAudit(
			auditRow({
				controlId: "prompt_injection",
				detail: LONG_EVIDENCE_DETAIL,
			}),
		);

		const page = await store.poll(0, 100);
		expect(page.events).toHaveLength(1);
		expect(page.events[0]?.detail).toBe(LONG_EVIDENCE_DETAIL);
		expect(page.events[0]?.detail?.length).toBe(LONG_EVIDENCE_DETAIL.length);
	});
});
