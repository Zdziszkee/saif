import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { auditEvents, mcpToolCalls, usageRecords } from "./schema.ts";

const schema = { auditEvents, mcpToolCalls, usageRecords };

/** Shared database handle shape for every repository in `src/db/`. */
export type Db = BunSQLiteDatabase<typeof schema>;

/**
 * Local-dev fallback: an explicit `DATABASE_URL` always wins, otherwise the
 * file-backed dev database is used so imports never crash without env setup.
 */
const DEFAULT_DATABASE_URL = "file:data/saif.db";

function resolveDatabaseUrl(): string {
	const { DATABASE_URL: url } = process.env;
	return url ?? DEFAULT_DATABASE_URL;
}

/** Creates parent directories for file-backed databases; a no-op for `:memory:`. */
function ensureParentDir(url: string): void {
	const path = url.startsWith("file:") ? url.slice("file:".length) : url;
	if (path === ":memory:") {
		return;
	}
	mkdirSync(dirname(path), { recursive: true });
}

function createDb(): Db {
	const url = resolveDatabaseUrl();
	ensureParentDir(url);
	return drizzle(new Database(url), { schema });
}

let cached: Db | undefined;

/**
 * Lazy database singleton. Nothing touches the filesystem at import time, so
 * tests and local dev can import this module without `DATABASE_URL` set; the
 * connection opens on first use and is shared afterwards.
 *
 * First run against a fresh file requires `bun run db:migrate` (or point
 * `DATABASE_URL` at an already-migrated file): drizzle never auto-migrates,
 * so writes to an unmigrated file fail.
 */
export function getDb(): Db {
	cached ??= createDb();
	return cached;
}

/**
 * Back-compat handle for `import { db }`: a lazy proxy over {@link getDb},
 * so existing call sites keep working without paying for an eager connection
 * at import. Prefer {@link getDb} in new code.
 */
export const db: Db = new Proxy({} as Db, {
	get(_target, property, receiver) {
		return Reflect.get(getDb(), property, receiver);
	},
});
