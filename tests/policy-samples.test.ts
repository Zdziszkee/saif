import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { parsePolicy } from "#/control/policy/schema.ts";

const SAMPLE_FILES = ["policy.json", "policy.permissive.json", "policy.strict.json"];

async function loadSample(name: string): Promise<unknown> {
	const text = await readFile(new URL(`../${name}`, import.meta.url), "utf8");
	const document: unknown = JSON.parse(text);
	return document;
}

describe("sample policy documents", () => {
	for (const name of SAMPLE_FILES) {
		it(`validates ${name} against the schema`, async () => {
			const result = parsePolicy(await loadSample(name));
			if (!result.success) {
				throw new Error(
					`${name} failed validation: ${result.issues.map((issue) => issue.message).join("; ")}`,
				);
			}
			expect(result.success).toBe(true);
		});
	}

	it("keeps the sample variants on distinct strictness settings", async () => {
		const standard = await loadSample("policy.json");
		const permissive = await loadSample("policy.permissive.json");
		const strict = await loadSample("policy.strict.json");
		expect(JSON.stringify(permissive)).not.toBe(JSON.stringify(standard));
		expect(JSON.stringify(strict)).not.toBe(JSON.stringify(standard));
	});
});
