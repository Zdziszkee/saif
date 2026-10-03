import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: [".env.local", ".env"] });

const { DATABASE_URL: url } = process.env;
if (url === undefined) {
	throw new Error("DATABASE_URL must be set");
}

export default defineConfig({
	dbCredentials: {
		url,
	},
	dialect: "sqlite",
	out: "./drizzle",
	schema: "./src/db/schema.ts",
});
