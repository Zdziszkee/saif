import { drizzle } from "drizzle-orm/better-sqlite3";

import { todos } from "./schema.ts";

const { DATABASE_URL: url } = process.env;
if (url === undefined) {
	throw new Error("DATABASE_URL must be set");
}

export const db = drizzle(url, { schema: { todos } });
