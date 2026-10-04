/**
 * Test-only DDL for the gateway storage tables.
 *
 * Single copy of the `CREATE TABLE` statements used by tests that need a
 * throwaway sqlite file. Keep in sync with `drizzle/` migrations and
 * `src/db/schema.ts`; the schema file stays the source of truth and these
 * statements exist only because tests must not depend on migration filenames.
 */

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { GatewayStoreWithSpendDetail } from "#/db/repositories.ts";
import { createGatewayStore } from "#/db/repositories.ts";
import { auditEvents, mcpToolCalls, usageRecords } from "#/db/schema.ts";

export const GATEWAY_TABLES_DDL = `
	CREATE TABLE audit_events (
		cause TEXT,
		control_id TEXT,
		detail TEXT,
		user_group_id TEXT NOT NULL,
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		model TEXT,
		policy_version TEXT NOT NULL,
		prompt_text TEXT,
		score REAL,
		ts INTEGER NOT NULL DEFAULT (unixepoch()),
		user_id TEXT,
		verdict TEXT NOT NULL
	);
	CREATE TABLE usage_records (
		audit_event_id INTEGER REFERENCES audit_events(id) ON DELETE SET NULL,
		completion_tokens INTEGER NOT NULL,
		cost_usd REAL,
		user_group_id TEXT NOT NULL,
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		model TEXT NOT NULL,
		prompt_tokens INTEGER NOT NULL,
		ts INTEGER NOT NULL DEFAULT (unixepoch()),
		user_id TEXT
	);
`;

const IN_MEMORY_SQLITE = ":memory:";

/**
 * Build an isolated store over a throwaway in-memory sqlite file seeded with
 * {@link GATEWAY_TABLES_DDL}. Centralizes test DDL so suites never duplicate
 * `CREATE TABLE` strings or drizzle wiring.
 */
export function setupIsolatedGatewayStore(): GatewayStoreWithSpendDetail {
	const sqlite = new Database(IN_MEMORY_SQLITE);
	sqlite.exec(GATEWAY_TABLES_DDL);
	// Full production schema shape: `createGatewayStore` takes `AppDatabase`
	// (`typeof db`), so the table map must match exactly even though the
	// gateway store never queries `mcpToolCalls`. No DDL needed for it —
	// drizzle only touches tables a query references.
	return createGatewayStore(
		drizzle(sqlite, { schema: { auditEvents, mcpToolCalls, usageRecords } }),
	);
}
