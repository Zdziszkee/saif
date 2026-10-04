/**
 * Test-only DDL for the gateway storage tables.
 *
 * Single copy of the `CREATE TABLE` statements used by tests that need a
 * throwaway sqlite file. Keep in sync with `drizzle/` migrations and
 * `src/db/schema.ts`; the schema file stays the source of truth and these
 * statements exist only because tests must not depend on migration filenames.
 */

export const GATEWAY_TABLES_DDL = `
	CREATE TABLE audit_events (
		cause TEXT,
		control_id TEXT,
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
