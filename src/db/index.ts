import { Database } from "bun:sqlite";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { auditEvents, usageRecords } from "./schema.ts";

const { DATABASE_URL: url } = process.env;
if (url === undefined) {
	throw new Error("DATABASE_URL must be set");
}

export const db = drizzle(new Database(url), {
	schema: { auditEvents, usageRecords },
});
