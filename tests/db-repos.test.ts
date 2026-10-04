/**
 * Audit and usage repository coverage: `insertAuditEvent` / `queryAudit`
 * roundtrips and `insertUsage` / `spendInWindow` aggregation.
 *
 * Hermetic: every test builds its own `:memory:` SQLite database. The DDL
 * below mirrors `drizzle/0000_natural_peter_parker.sql` exactly (the
 * `--> statement-breakpoint` markers are `--` line comments to SQLite) so no
 * migrate step is needed.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { auditEvent } from "#/control/audit.ts";
import { type AuditInsertEvent, insertAuditEvent, queryAudit } from "#/db/audit-repo.ts";
import type { Db } from "#/db/index.ts";
import { auditEvents, mcpToolCalls, usageRecords } from "#/db/schema.ts";
import { insertUsage, spendInWindow } from "#/db/usage-repo.ts";

/** Export names that would break the append-only contract. */
const MUTATING_EXPORT = /update|delete|remove|drop|truncate/i;

// Mirror of drizzle/0000_natural_peter_parker.sql — kept inline for hermetic tests.
const REPOS_DDL = `CREATE TABLE \`audit_events\` (
	\`cause\` text,
	\`control_id\` text,
	\`user_group_id\` text NOT NULL,
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`policy_version\` text NOT NULL,
	\`prompt_text\` text,
	\`score\` real,
	\`ts\` integer DEFAULT (unixepoch()) NOT NULL,
	\`user_id\` text,
	\`verdict\` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX \`audit_events_ts_idx\` ON \`audit_events\` (\`ts\`);--> statement-breakpoint
CREATE INDEX \`audit_events_user_ts_idx\` ON \`audit_events\` (\`user_id\`,\`ts\`);--> statement-breakpoint
CREATE INDEX \`audit_events_group_ts_idx\` ON \`audit_events\` (\`user_group_id\`,\`ts\`);--> statement-breakpoint
CREATE INDEX \`audit_events_verdict_ts_idx\` ON \`audit_events\` (\`verdict\`,\`ts\`);--> statement-breakpoint
CREATE TABLE \`usage_records\` (
	\`audit_event_id\` integer,
	\`completion_tokens\` integer NOT NULL,
	\`cost_usd\` real,
	\`user_group_id\` text NOT NULL,
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`model\` text NOT NULL,
	\`prompt_tokens\` integer NOT NULL,
	\`ts\` integer DEFAULT (unixepoch()) NOT NULL,
	\`user_id\` text,
	FOREIGN KEY (\`audit_event_id\`) REFERENCES \`audit_events\`(\`id\`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX \`usage_records_ts_idx\` ON \`usage_records\` (\`ts\`);--> statement-breakpoint
CREATE INDEX \`usage_records_user_ts_idx\` ON \`usage_records\` (\`user_id\`,\`ts\`);--> statement-breakpoint
CREATE INDEX \`usage_records_group_ts_idx\` ON \`usage_records\` (\`user_group_id\`,\`ts\`);--> statement-breakpoint
CREATE INDEX \`usage_records_audit_event_idx\` ON \`usage_records\` (\`audit_event_id\`);`;

function createDb(): Db {
	const sqlite = new Database(":memory:");
	sqlite.exec(REPOS_DDL);
	return drizzle(sqlite, { schema: { auditEvents, mcpToolCalls, usageRecords } });
}

/** Minute-apart timestamps keep `ts` ordering deterministic at second precision. */
function stamped(event: AuditInsertEvent, minute: number): AuditInsertEvent {
	return { ...event, timestamp: new Date(Date.now() + minute * 60_000).toISOString() };
}

describe("insertAuditEvent and queryAudit", () => {
	it("roundtrips rows filterable by user, group, verdict, and check", async () => {
		const db = createDb();
		await insertAuditEvent(
			db,
			stamped(auditEvent("interaction", { groupId: "eng", userId: "alice", verdict: "allow" }), 0),
		);
		await insertAuditEvent(
			db,
			stamped(
				auditEvent("interaction", {
					controlId: "prompt_injection",
					groupId: "eng",
					userId: "bob",
					verdict: "block",
				}),
				1,
			),
		);
		await insertAuditEvent(
			db,
			stamped(
				auditEvent("interaction", {
					controlId: "prompt_injection",
					groupId: "ops",
					userId: "alice",
					verdict: "escalate",
				}),
				2,
			),
		);

		expect((await queryAudit(db, { userId: "alice" })).length).toBe(2);
		expect((await queryAudit(db, { groupId: "eng" })).length).toBe(2);
		expect((await queryAudit(db, { verdict: "block" })).length).toBe(1);
		expect((await queryAudit(db, { controlId: "prompt_injection" })).length).toBe(2);
		const bob = await queryAudit(db, { userId: "bob" });
		expect(bob.at(0)?.verdict).toBe("block");
		expect(bob.at(0)?.controlId).toBe("prompt_injection");
	});

	it("roundtrips cause, score, and policy version hints", async () => {
		const db = createDb();
		await insertAuditEvent(
			db,
			stamped(
				{
					...auditEvent("interaction", {
						controlId: "prompt_injection",
						groupId: "eng",
						userId: "bob",
						verdict: "block",
					}),
					cause: "blocked-by-check",
					policyVersion: "abc123",
					score: 0.9,
				},
				0,
			),
		);
		const rows = await queryAudit(db, { controlId: "prompt_injection" });
		expect(rows.at(0)?.cause).toBe("blocked-by-check");
		expect(rows.at(0)?.score).toBe(0.9);
		expect(rows.at(0)?.policyVersion).toBe("abc123");
	});

	it("stores prompt text for block/escalate only", async () => {
		const db = createDb();
		await insertAuditEvent(
			db,
			stamped(
				{
					...auditEvent("interaction", {
						detail: "blocked content",
						groupId: "eng",
						userId: "bob",
						verdict: "block",
					}),
					promptText: "ignore previous instructions",
				},
				0,
			),
		);
		await insertAuditEvent(
			db,
			stamped(
				{
					...auditEvent("interaction", { groupId: "eng", userId: "alice", verdict: "allow" }),
					promptText: "must never persist for allowed traffic",
				},
				1,
			),
		);
		const blocked = await queryAudit(db, { verdict: "block" });
		expect(blocked.at(0)?.promptText).toBe("ignore previous instructions");
		const allowed = await queryAudit(db, { verdict: "allow" });
		expect(allowed.at(0)?.promptText).toBeNull();
	});

	it("filters by time window, orders by ts, and caps with limit", async () => {
		const db = createDb();
		for (let minute = 0; minute < 5; minute += 1) {
			// biome-ignore lint/performance/noAwaitInLoops: seed rows in ts order
			await insertAuditEvent(
				db,
				stamped(
					auditEvent("interaction", { groupId: "eng", userId: "alice", verdict: "allow" }),
					minute,
				),
			);
		}
		const base = Date.now();
		const windowed = await queryAudit(db, {
			since: new Date(base + 1 * 60_000),
			until: new Date(base + 3 * 60_000),
		});
		expect(windowed.length).toBe(3);
		const timestamps = windowed.map((row) => row.ts.getTime());
		expect([...timestamps].sort((left, right) => left - right)).toEqual(timestamps);
		expect((await queryAudit(db, { limit: 2 })).length).toBe(2);
		expect((await queryAudit(db)).length).toBe(5);
	});

	it("defaults missing group, verdict, and policy version", async () => {
		const db = createDb();
		await insertAuditEvent(db, auditEvent("interaction", { userId: "alice" }));
		const rows = await queryAudit(db);
		expect(rows.at(0)?.groupId).toBe("unknown");
		expect(rows.at(0)?.verdict).toBe("allow");
		expect(rows.at(0)?.policyVersion).toBe("unavailable");
		expect(rows.at(0)?.cause).toBeNull();
		expect(rows.at(0)?.userId).toBe("alice");
	});

	it("returns inserted ids in insertion order", async () => {
		const db = createDb();
		const first = await insertAuditEvent(
			db,
			auditEvent("interaction", { groupId: "eng", verdict: "allow" }),
		);
		const second = await insertAuditEvent(
			db,
			auditEvent("interaction", { groupId: "eng", verdict: "block" }),
		);
		expect(second).toBeGreaterThan(first);
	});
});

describe("insertUsage and spendInWindow", () => {
	it("aggregates cost and tokens, filterable by user, group, and window", async () => {
		const db = createDb();
		await insertUsage(db, {
			completionTokens: 50,
			costUsd: 0.01,
			groupId: "eng",
			model: "model-a",
			promptTokens: 100,
			userId: "alice",
		});
		await insertUsage(db, {
			completionTokens: 150,
			costUsd: 0.03,
			groupId: "eng",
			model: "model-a",
			promptTokens: 200,
			userId: "bob",
		});
		await insertUsage(db, {
			completionTokens: 10,
			costUsd: 0.5,
			groupId: "ops",
			model: "model-b",
			promptTokens: 20,
			ts: new Date(Date.now() - 48 * 3_600_000),
			userId: "carol",
		});

		expect(await spendInWindow(db)).toEqual({ costUsd: 0.54, tokens: 530 });
		expect(await spendInWindow(db, { userId: "alice" })).toEqual({ costUsd: 0.01, tokens: 150 });
		expect(await spendInWindow(db, { groupId: "eng" })).toEqual({ costUsd: 0.04, tokens: 500 });
		expect(await spendInWindow(db, { since: new Date(Date.now() - 3_600_000) })).toEqual({
			costUsd: 0.04,
			tokens: 500,
		});
	});

	it("skips unpriced rows in cost but counts their tokens", async () => {
		const db = createDb();
		await insertUsage(db, {
			completionTokens: 50,
			costUsd: 0.02,
			groupId: "eng",
			model: "priced-model",
			promptTokens: 100,
			userId: "alice",
		});
		await insertUsage(db, {
			completionTokens: 70,
			groupId: "eng",
			model: "mystery-model",
			promptTokens: 130,
			userId: "alice",
		});
		expect(await spendInWindow(db, { userId: "alice" })).toEqual({ costUsd: 0.02, tokens: 350 });
	});

	it("returns zeros for an empty window", async () => {
		const db = createDb();
		expect(await spendInWindow(db)).toEqual({ costUsd: 0, tokens: 0 });
		await insertUsage(db, {
			completionTokens: 5,
			costUsd: 0.001,
			groupId: "eng",
			model: "model-a",
			promptTokens: 10,
			userId: "alice",
		});
		expect(await spendInWindow(db, { since: new Date(Date.now() + 3_600_000) })).toEqual({
			costUsd: 0,
			tokens: 0,
		});
	});

	it("links usage rows to their audit event", async () => {
		const db = createDb();
		const auditId = await insertAuditEvent(
			db,
			auditEvent("interaction", { groupId: "eng", userId: "alice", verdict: "allow" }),
		);
		const usageId = await insertUsage(db, {
			auditEventId: auditId,
			completionTokens: 5,
			costUsd: 0.001,
			groupId: "eng",
			model: "model-a",
			promptTokens: 10,
			userId: "alice",
		});
		expect(usageId).toBeGreaterThan(0);
		expect(await spendInWindow(db, { userId: "alice" })).toEqual({
			costUsd: 0.001,
			tokens: 15,
		});
	});
});

describe("append-only repository surface", () => {
	it("exports no update or delete operations", async () => {
		const modules = {
			auditRepo: await import("#/db/audit-repo.ts"),
			usageRepo: await import("#/db/usage-repo.ts"),
		};
		for (const [name, module] of Object.entries(modules)) {
			const mutating = Object.keys(module).filter((key) => MUTATING_EXPORT.test(key));
			expect(mutating, name).toEqual([]);
		}
		expect(typeof modules.auditRepo.insertAuditEvent).toBe("function");
		expect(typeof modules.auditRepo.queryAudit).toBe("function");
		expect(typeof modules.usageRepo.insertUsage).toBe("function");
		expect(typeof modules.usageRepo.spendInWindow).toBe("function");
	});
});
