/**
 * Per-user token usage tests: `summarizeUserTokenUsage` aggregation plus the
 * `buildDashboardData` 5th-param wiring (present, empty by default).
 */
import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import type { PolicySnapshot } from "#/control/policy/loader.ts";
import { parsePolicy } from "#/control/policy/schema.ts";
import { buildDashboardData, summarizeUserTokenUsage } from "#/dashboard/data.ts";

const GENERATED_AT = "2026-10-04T20:00:00.000Z";

async function loadSnapshot(): Promise<PolicySnapshot> {
	const text = await readFile(new URL("../policy.json", import.meta.url), "utf8");
	const document: unknown = JSON.parse(text);
	const parsed = parsePolicy(document);
	if (!parsed.success) {
		throw new Error(
			`policy.json failed validation: ${parsed.issues.map((issue) => issue.message).join("; ")}`,
		);
	}
	return { policy: parsed.policy, policyVersion: "sha256.test-usage" };
}

const SNAPSHOT = await loadSnapshot();

describe("summarizeUserTokenUsage", () => {
	it("aggregates multiple rows per user and sorts desc by totalTokens", () => {
		const rows = summarizeUserTokenUsage([
			{ completionTokens: 10, costUsd: 0.01, model: "gpt-a", promptTokens: 90, userId: "alice" },
			{ completionTokens: 5, costUsd: 0.02, model: "gpt-b", promptTokens: 5, userId: "alice" },
			{ completionTokens: 500, costUsd: 1, model: "gpt-a", promptTokens: 500, userId: "bob" },
		]);
		expect(rows.map((row) => row.userId)).toEqual(["bob", "alice"]);
		const alice = rows.find((row) => row.userId === "alice");
		expect(alice).toMatchObject({
			completionTokens: 15,
			promptTokens: 95,
			requests: 2,
			totalTokens: 110,
		});
		expect(alice?.models).toEqual(["gpt-a", "gpt-b"]);
	});

	it("yields null costUsd when all rows unpriced, sums when mixed", () => {
		const [unpriced] = summarizeUserTokenUsage([
			{ completionTokens: 1, costUsd: null, model: "m", promptTokens: 1, userId: "u1" },
			{ completionTokens: 1, costUsd: undefined, model: "m", promptTokens: 1, userId: "u1" },
		]);
		expect(unpriced?.costUsd).toBeNull();
		const [mixed] = summarizeUserTokenUsage([
			{ completionTokens: 1, costUsd: null, model: "m", promptTokens: 1, userId: "u2" },
			{ completionTokens: 1, costUsd: 0.25, model: "m", promptTokens: 1, userId: "u2" },
		]);
		expect(mixed?.costUsd).toBeCloseTo(0.25, 10);
	});

	it("skips blank-userId rows; omits blank model but counts tokens", () => {
		const rows = summarizeUserTokenUsage([
			{ completionTokens: 5, costUsd: 1, model: "m", promptTokens: 5, userId: "  " },
			{ completionTokens: 5, costUsd: 1, model: "m", promptTokens: 5, userId: null },
			{ completionTokens: 7, costUsd: 0.1, model: "   ", promptTokens: 3, userId: "carol" },
			{ completionTokens: 1, costUsd: 0.1, model: "gpt-x", promptTokens: 1, userId: "carol" },
		]);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			completionTokens: 8,
			promptTokens: 4,
			requests: 2,
			totalTokens: 12,
			userId: "carol",
		});
		expect(rows[0]?.models).toEqual(["gpt-x"]);
	});

	it("coerces non-integer and garbage counts to 0", () => {
		const [row] = summarizeUserTokenUsage([
			{
				completionTokens: 1.5,
				costUsd: 0.5,
				model: "m",
				promptTokens: "nope",
				userId: "dave",
			},
			{
				completionTokens: Number.NaN,
				costUsd: null,
				model: "m",
				promptTokens: Number.POSITIVE_INFINITY,
				userId: "dave",
			},
		]);
		expect(row).toMatchObject({
			completionTokens: 0,
			promptTokens: 0,
			requests: 2,
			totalTokens: 0,
		});
		expect(row?.costUsd).toBeCloseTo(0.5, 10);
	});

	it("returns [] for empty input", () => {
		expect(summarizeUserTokenUsage([])).toEqual([]);
	});
});

describe("buildDashboardData userTokenUsage", () => {
	it("defaults to empty when the 5th param is omitted", () => {
		const data = buildDashboardData(SNAPSHOT, GENERATED_AT, []);
		expect(data.userTokenUsage).toEqual([]);
	});

	it("projects the 5th param through summarizeUserTokenUsage", () => {
		const data = buildDashboardData(SNAPSHOT, GENERATED_AT, [], {}, [
			{ completionTokens: 2, costUsd: 0.1, model: "m", promptTokens: 3, userId: "erin" },
		]);
		expect(data.userTokenUsage).toHaveLength(1);
		expect(data.userTokenUsage[0]).toMatchObject({ totalTokens: 5, userId: "erin" });
	});
});
