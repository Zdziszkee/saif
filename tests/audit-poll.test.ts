import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";

import { createGatewayStore } from "#/db/repositories.ts";
import { auditEvents, usageRecords } from "#/db/schema.ts";
import type { GatewayStore } from "#/gateway/store.ts";
import { handleAuditPoll } from "#/routes/api.audit.ts";
import { GATEWAY_TABLES_DDL } from "./helpers/tables.ts";

function setupStore() {
	const sqlite = new Database(":memory:");
	sqlite.exec(GATEWAY_TABLES_DDL);
	return createGatewayStore(drizzle(sqlite, { schema: { auditEvents, usageRecords } }));
}

interface AuditPollBody {
	events: Array<{ id?: unknown; ts?: unknown; verdict?: unknown }>;
	usage: Array<{ costUsd?: unknown; id?: unknown; ts?: unknown }>;
}

async function bodyOf(response: Response): Promise<AuditPollBody> {
	return (await response.json()) as AuditPollBody;
}

function pollRequest(query = ""): Request {
	return new Request(`http://test.local/api/audit${query}`);
}

describe("GET /api/audit", () => {
	it("returns events and usage with id and ts, paged by since cursor", async () => {
		const backing = setupStore();
		const first = await backing.recordAudit({
			cause: null,
			controlId: null,
			groupId: "hr",
			model: null,
			policyVersion: "v1",
			promptText: null,
			score: null,
			userId: "alice",
			verdict: "allow",
		});
		await backing.recordAudit({
			cause: "blocked-by-check",
			controlId: "prompt_injection",
			groupId: "hr",
			model: null,
			policyVersion: "v1",
			promptText: "evil prompt",
			score: 0.9,
			userId: "alice",
			verdict: "block",
		});
		await backing.recordUsage({
			auditEventId: first,
			completionTokens: 20,
			costUsd: null,
			groupId: "hr",
			model: "unknown-model",
			promptTokens: 80,
			userId: "alice",
		});

		const response = await handleAuditPoll(pollRequest("?since=0&limit=100"), backing);
		expect(response.status).toBe(200);
		const body = await bodyOf(response);
		expect(body.events).toHaveLength(2);
		expect(body.events[0]?.verdict).toBe("allow");
		for (const event of body.events) {
			expect(typeof event.id).toBe("number");
			expect(typeof event.ts).toBe("number");
		}
		expect(body.usage).toHaveLength(1);
		expect(body.usage[0]?.costUsd).toBeNull();
		expect(typeof body.usage[0]?.id).toBe("number");
		expect(typeof body.usage[0]?.ts).toBe("number");

		const paged = await bodyOf(
			await handleAuditPoll(pollRequest(`?since=${first}&limit=100`), backing),
		);
		expect(paged.events).toHaveLength(1);
		expect(paged.events[0]?.verdict).toBe("block");
		expect(paged.usage).toHaveLength(0);
	});

	it("defaults since to zero and limit to one hundred", async () => {
		const backing = setupStore();
		let seen: { cursor: number; limit: number } | undefined;
		const store: GatewayStore = {
			poll: (cursor, limit) => {
				seen = { cursor, limit };
				return backing.poll(cursor, limit);
			},
			recordAudit: (row) => backing.recordAudit(row),
			recordUsage: (row) => backing.recordUsage(row),
			spendSince: (userId, since) => backing.spendSince(userId, since),
		};

		const response = await handleAuditPoll(pollRequest(), store);
		expect(response.status).toBe(200);
		expect(seen).toEqual({ cursor: 0, limit: 100 });
	});

	it("clamps limit to one thousand", async () => {
		const backing = setupStore();
		let seenLimit = 0;
		const store: GatewayStore = {
			poll: (cursor, limit) => {
				seenLimit = limit;
				return backing.poll(cursor, limit);
			},
			recordAudit: (row) => backing.recordAudit(row),
			recordUsage: (row) => backing.recordUsage(row),
			spendSince: (userId, since) => backing.spendSince(userId, since),
		};

		const response = await handleAuditPoll(pollRequest("?limit=5000"), store);
		expect(response.status).toBe(200);
		expect(seenLimit).toBe(1000);
	});

	it("rejects malformed since and limit", async () => {
		const backing = setupStore();
		expect((await handleAuditPoll(pollRequest("?since=nope"), backing)).status).toBe(400);
		expect((await handleAuditPoll(pollRequest("?since=-3"), backing)).status).toBe(400);
		expect((await handleAuditPoll(pollRequest("?limit=0"), backing)).status).toBe(400);
		expect((await handleAuditPoll(pollRequest("?limit=nope"), backing)).status).toBe(400);
	});
});
