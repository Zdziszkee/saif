import { describe, expect, it } from "bun:test";
import {
	buildSignatureFeed,
	parseAtlasSnapshot,
	parseOwaspSnapshot,
} from "../scripts/build-signature-feed.ts";

const AddedAt = "2026-10-04T00:00:00.000Z";

function curatedEntry(overrides: Record<string, unknown>): Record<string, unknown> {
	return {
		addedAt: AddedAt,
		description: "test entry",
		enabled: true,
		id: "t-1",
		kind: "jailbreak",
		name: "Test entry",
		pattern: "do\\s+anything\\s+now",
		references: [],
		severity: "high",
		source: "test-fixture",
		updatedAt: AddedAt,
		...overrides,
	};
}

function atlasBundle(objects: unknown[]): unknown {
	return { id: "bundle--test", objects, spec_version: "2.1", type: "bundle" };
}

function attackPattern(overrides: Record<string, unknown>): unknown {
	return {
		created: AddedAt,
		description: "test technique",
		external_references: [],
		id: "attack-pattern--test",
		modified: AddedAt,
		name: "Test technique",
		spec_version: "2.1",
		type: "attack-pattern",
		x_signature_ids: [],
		...overrides,
	};
}

describe("atlas snapshot parsing", () => {
	it("picks claimed ids and keeps references", () => {
		const parsed = parseAtlasSnapshot(
			atlasBundle([
				attackPattern({
					external_references: [{ source_name: "mitre-atlas", url: "https://atlas.mitre.org/" }],
					name: "LLM Jailbreak",
					x_signature_ids: ["jail-dan"],
				}),
			]),
		);
		expect(parsed.errors).toEqual([]);
		expect(parsed.picks.map((pick) => pick.name)).toEqual(["LLM Jailbreak"]);
		expect(parsed.picks[0]?.claims).toEqual(["jail-dan"]);
		expect(parsed.picks[0]?.references).toEqual(["https://atlas.mitre.org/"]);
	});

	it("skips revoked techniques and non-attack objects", () => {
		const parsed = parseAtlasSnapshot(
			atlasBundle([
				attackPattern({ name: "Revoked", revoked: true, x_signature_ids: ["retired"] }),
				{
					created: AddedAt,
					id: "identity--test",
					identity_class: "organization",
					modified: AddedAt,
					name: "mirror",
					spec_version: "2.1",
					type: "identity",
				},
			]),
		);
		expect(parsed.picks).toEqual([]);
		expect(parsed.errors.length).toBeGreaterThan(0);
	});

	it("rejects a non-bundle document", () => {
		const parsed = parseAtlasSnapshot({ nope: true });
		expect(parsed.picks).toEqual([]);
		expect(parsed.errors.length).toBeGreaterThan(0);
	});
});

describe("owasp snapshot parsing", () => {
	it("collects categories and claims", () => {
		const parsed = parseOwaspSnapshot({
			categories: [
				{ id: "LLM01", signature_ids: ["inj-ignore-previous"], title: "Prompt Injection" },
			],
			source: "owasp-llm-top10",
			version: "2025",
		});
		expect(parsed.errors).toEqual([]);
		expect(parsed.categories).toEqual(["LLM01"]);
		expect(parsed.claims).toEqual(["inj-ignore-previous"]);
	});

	it("rejects a document without categories", () => {
		const parsed = parseOwaspSnapshot({ source: "owasp-llm-top10" });
		expect(parsed.categories).toEqual([]);
		expect(parsed.errors.length).toBeGreaterThan(0);
	});
});

describe("feed building", () => {
	const atlas = atlasBundle([
		attackPattern({ name: "LLM Jailbreak", x_signature_ids: ["t-1", "t-2"] }),
	]);
	const owasp = {
		categories: [{ id: "LLM01", signature_ids: ["t-1"], title: "Prompt Injection" }],
		source: "owasp-llm-top10",
		version: "2025",
	};

	it("builds a sorted feed from curated rows", () => {
		const built = buildSignatureFeed(
			[curatedEntry({ id: "t-2" }), curatedEntry({ id: "t-1" })],
			atlas,
			owasp,
		);
		expect(built.errors).toEqual([]);
		expect(built.warnings).toEqual([]);
		expect(built.document.map((entry) => entry.id)).toEqual(["t-1", "t-2"]);
	});

	it("skips invalid rows without emptying the feed", () => {
		const built = buildSignatureFeed(
			[
				curatedEntry({ id: "good" }),
				curatedEntry({ id: "bad-regex", pattern: "([unclosed" }),
				{ id: "broken" },
				curatedEntry({ id: "good", pattern: "aaa" }),
			],
			undefined,
			undefined,
		);
		expect(built.document.map((entry) => entry.id)).toEqual(["good"]);
		expect(built.errors.length).toBe(3);
	});

	it("keeps building when a source is unreachable", () => {
		const built = buildSignatureFeed([curatedEntry({ id: "t-1" })], undefined, undefined);
		expect(built.errors).toEqual([]);
		expect(built.document.map((entry) => entry.id)).toEqual(["t-1"]);
	});

	it("warns on unclaimed ids and unknown snapshot claims", () => {
		const built = buildSignatureFeed(
			[curatedEntry({ id: "unclaimed" })],
			atlasBundle([attackPattern({ name: "Ahead", x_signature_ids: ["future-id"] })]),
			undefined,
		);
		expect(built.document.map((entry) => entry.id)).toEqual(["unclaimed"]);
		expect(built.warnings.join("\n")).toContain("unclaimed curated id unclaimed");
		expect(built.warnings.join("\n")).toContain("unknown snapshot claim future-id");
	});

	it("fails closed on zero usable rows", () => {
		const built = buildSignatureFeed([{ id: "broken" }], undefined, undefined);
		expect(built.document).toEqual([]);
		expect(built.errors.length).toBeGreaterThan(0);
	});
});
