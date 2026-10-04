import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectSensitive } from "#/control/deterministic/detectors.ts";
import { guardInteraction } from "#/control/guard.ts";
import { handleGuardRequest } from "#/control/guard-api.ts";
import { createSignatureFeedStore, loadSignatureFeed } from "#/control/signatures/feed.ts";
import { type CallerIdentity, USER_GROUP_ID_HEADER, USER_ID_HEADER } from "#/control/subjects.ts";
import type { Control, ControlPipeline, Interaction } from "#/control/types.ts";
import type { CatalogEntry } from "#/hub/catalog.ts";
import { createToolGovernor } from "#/hub/governance.ts";
import { createGrantRegistry } from "#/hub/grants.ts";
import {
	auditSink,
	blockOn,
	hangingControl,
	identityResolver,
	pipelineWith,
} from "./helpers/fixtures.ts";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const POLICY_REASON = /^\[policy\] custom-policy/;

const aliceIdentity: CallerIdentity = { groupId: "hr", userId: "alice" };

function interaction(content = "hello"): Interaction {
	return {
		content,
		direction: "inbound",
		groupId: "hr",
		id: `leftover-${content.length}`,
		seam: "guard-api",
		userId: "alice",
	};
}

function guardRequest(body: unknown, identity: CallerIdentity = aliceIdentity): Request {
	const headers = new Headers({ "content-type": "application/json" });
	headers.set(USER_ID_HEADER, identity.userId);
	headers.set(USER_GROUP_ID_HEADER, identity.groupId);
	return new Request("http://test.local/api/guard", {
		body: JSON.stringify(body),
		headers,
		method: "POST",
	});
}

describe("guard pipeline-throw fail-closed path", () => {
	it("synthesizes a pipeline block when inspect throws an Error", async () => {
		// Arrange: a pipeline double that rejects with an Error.
		const sink = auditSink();
		const pipeline: ControlPipeline = {
			inspect: () => Promise.reject(new Error("boom")),
		};

		// Act.
		const outcome = await guardInteraction(interaction(), pipeline, {
			audit: sink,
			consumerKey: "alice",
		});

		// Assert: fail-closed block attributed to the pipeline, content withheld.
		expect(outcome.verdict).toBe("block");
		expect(outcome.rejection).toEqual({ control: "pipeline", status: 403, verdict: "block" });
		expect(outcome.inspection.failure).toBe("boom");
		expect(outcome.inspection.content).toBe("hello");
		expect(outcome.content).toBeUndefined();
		expect(sink.events).toHaveLength(1);
		expect(sink.events.at(0)?.detail).toBe("boom");
	});

	it("stringifies a non-Error pipeline throw into the failure", async () => {
		// Arrange: a pipeline double that rejects with a plain string.
		const pipeline: ControlPipeline = {
			inspect: () => Promise.reject("plain-string-failure"),
		};

		// Act.
		const outcome = await guardInteraction(interaction(), pipeline);

		// Assert.
		expect(outcome.verdict).toBe("block");
		expect(outcome.rejection?.control).toBe("pipeline");
		expect(outcome.inspection.failure).toBe("plain-string-failure");
	});
});

describe("pipeline control-error and latency edges", () => {
	it("fails closed when a control exceeds its budget", async () => {
		// Arrange: a control that never resolves under a 5ms budget (short,
		// hermetic timer — no network, fs, or external clock).
		const sink = auditSink();

		// Act.
		const result = await pipelineWith([hangingControl()], {
			audit: sink,
			timeoutMs: 5,
		}).inspect(interaction());

		// Assert.
		expect(result.verdict).toBe("block");
		expect(result.failure).toContain("timed out");
		expect(result.blockingControl).toBe("fixture-hang");
	});

	it("fails closed when a control returns an unusable verdict", async () => {
		// Arrange.
		const bogus: Control = {
			id: "bogus",
			inspect: () => JSON.parse('{"verdict":"nope"}'),
		};

		// Act.
		const result = await pipelineWith([bogus]).inspect(interaction());

		// Assert.
		expect(result.verdict).toBe("block");
		expect(result.failure).toBe("control returned an unusable result");
		expect(result.blockingControl).toBe("bogus");
	});

	it("fails closed when a control returns an unusable redaction span", async () => {
		// Arrange: start past end is never a usable span.
		const bogus: Control = {
			id: "bogus-span",
			inspect: () => ({
				redactions: [
					{
						detectorId: "bogus-span",
						end: 2,
						kind: "bogus",
						placeholder: "[X]",
						start: 5,
					},
				],
				verdict: "allow",
			}),
		};

		// Act.
		const result = await pipelineWith([bogus]).inspect(interaction());

		// Assert.
		expect(result.verdict).toBe("block");
		expect(result.failure).toBe("control returned an unusable redaction span");
		expect(result.blockingControl).toBe("bogus-span");
	});
});

describe("signature feed unavailable and invalid snapshots", () => {
	it("rejects a non-array document with zero entries and a versioned stamp", () => {
		// Act.
		const loaded = loadSignatureFeed({ nope: true });

		// Assert.
		expect(loaded.entries).toEqual([]);
		expect(loaded.errors).toEqual([
			{ entryId: null, message: "feed must be an array of signature entries" },
		]);
		expect(loaded.version).toMatch(SHA256_HEX);
	});

	it("stamps the same document with a stable version", () => {
		// Act.
		const first = loadSignatureFeed([]);
		const second = loadSignatureFeed([]);

		// Assert.
		expect(first.errors).toEqual([]);
		expect(second.version).toBe(first.version);
	});

	it("serves the unavailable snapshot for a missing feed file", () => {
		// Arrange: a path that exists nowhere — no file is created, and the
		// missing-file watch degrades instead of throwing at construction.
		const store = createSignatureFeedStore(join(tmpdir(), "saif-missing-feed.json"));

		// Act.
		const snapshot = store.snapshot();
		const reloaded = store.reload();
		store.close();

		// Assert.
		expect(snapshot.ok).toBe(false);
		expect(snapshot.feed.version).toBe("unavailable");
		expect(snapshot.feed.entries).toEqual([]);
		expect(snapshot.errors).toHaveLength(1);
		expect(reloaded.ok).toBe(false);
		expect(reloaded.feed.version).toBe("unavailable");
	});

	it("keeps the last-good feed flagged unhealthy for invalid JSON", () => {
		// Arrange: an isolated temp-dir fixture, removed afterwards.
		const dir = mkdtempSync(join(tmpdir(), "saif-feed-"));
		const path = join(dir, "signatures.json");
		try {
			writeFileSync(path, "{ not json", "utf8");
			const store = createSignatureFeedStore(path);

			// Act.
			const snapshot = store.snapshot();
			store.close();

			// Assert.
			expect(snapshot.ok).toBe(false);
			expect(snapshot.feed.version).toBe("unavailable");
			expect(snapshot.feed.entries).toEqual([]);
			expect(snapshot.errors).toHaveLength(1);
		} finally {
			rmSync(dir, { force: true, recursive: true });
		}
	});

	it("reloads a valid feed file into a healthy snapshot", () => {
		// Arrange.
		const dir = mkdtempSync(join(tmpdir(), "saif-feed-"));
		const path = join(dir, "signatures.json");
		try {
			writeFileSync(path, "[]", "utf8");
			const store = createSignatureFeedStore(path);
			writeFileSync(
				path,
				JSON.stringify([
					{
						addedAt: "2026-01-01T00:00:00.000Z",
						description: "leftover test entry",
						id: "sig-leftover-1",
						kind: "injection",
						name: "Leftover",
						pattern: "leftover-marker",
						references: [],
						severity: "high",
						source: "unit-test",
						updatedAt: "2026-01-02T00:00:00.000Z",
					},
				]),
				"utf8",
			);

			// Act.
			const reloaded = store.reload();
			store.close();

			// Assert.
			expect(reloaded.ok).toBe(true);
			expect(reloaded.feed.entries).toHaveLength(1);
			expect(reloaded.errors).toEqual([]);
			expect(reloaded.feed.version).toMatch(SHA256_HEX);
		} finally {
			rmSync(dir, { force: true, recursive: true });
		}
	});
});

describe("guard API body-parse and engine fallbacks", () => {
	it("rejects an unparseable JSON body as malformed before any control runs", async () => {
		// Arrange: a body that makes request.json() reject, so the handler
		// falls back to a null body.
		const headers = new Headers({ "content-type": "application/json" });
		headers.set(USER_ID_HEADER, aliceIdentity.userId);
		headers.set(USER_GROUP_ID_HEADER, aliceIdentity.groupId);
		const request = new Request("http://test.local/api/guard", {
			body: "{oops",
			headers,
			method: "POST",
		});

		// Act.
		const response = await handleGuardRequest(request, {
			identity: identityResolver(),
			pipeline: pipelineWith([]),
		});

		// Assert.
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error?: string };
		expect(body.error).toBe("malformed_request");
	});

	it("attributes hits from unknown controls to the policy engine", async () => {
		// Arrange: a blocking control id outside the known engine mapping.
		const response = await handleGuardRequest(
			guardRequest({ content: "this goes boom", direction: "inbound", seam: "guard-api" }),
			{
				identity: identityResolver(),
				pipeline: pipelineWith([blockOn("boom", "custom-policy")]),
			},
		);

		// Act.
		const body = (await response.json()) as {
			control?: string;
			hits?: { engine?: string }[];
			reasons?: string[];
		};

		// Assert.
		expect(response.status).toBe(403);
		expect(body.control).toBe("custom-policy");
		expect(body.hits?.at(0)?.engine).toBe("policy");
		expect(body.reasons?.at(0)).toMatch(POLICY_REASON);
	});

	it("attributes semantic hits to the jev engine", async () => {
		// Arrange: a pipeline double reporting a semantic-tier block.
		const semanticBlock: ControlPipeline = {
			inspect: (seen) =>
				Promise.resolve({
					blockingControl: "semantic",
					content: seen.content,
					flagged: false,
					hits: [{ controlId: "semantic", kind: "semantic-test", verdict: "block" }],
					redactions: [],
					verdict: "block",
				}),
		};
		const response = await handleGuardRequest(
			guardRequest({ content: "needs a second opinion", direction: "inbound", seam: "guard-api" }),
			{ identity: identityResolver(), pipeline: semanticBlock },
		);

		// Act.
		const body = (await response.json()) as {
			hits?: { engine?: string }[];
		};

		// Assert.
		expect(response.status).toBe(403);
		expect(body.hits?.at(0)?.engine).toBe("jev");
	});
});

describe("tool governance serialization helpers", () => {
	it("falls back to empty args when tool args are not JSON-serializable", async () => {
		// Arrange: JSON.stringify of a function yields undefined, so the
		// inspected content is not JSON and parseArgs must fall back to {}.
		const grants = createGrantRegistry();
		grants.registerTool("echo", true);
		let received: unknown;
		const entry: CatalogEntry = {
			description: "echo",
			grantedByDefault: true,
			implementation: (args) => {
				received = args;
				return { done: true };
			},
			inputSchema: {},
			name: "echo",
			source: "builtin",
		};
		const allow: ControlPipeline = {
			inspect: (seen) =>
				Promise.resolve({
					blockingControl: undefined,
					content: seen.content,
					flagged: false,
					hits: [],
					redactions: [],
					verdict: "allow",
				}),
		};
		const governor = createToolGovernor({ grants, pipeline: allow });

		// Act.
		const outcome = await governor.governToolCall(entry, () => undefined, "hr");

		// Assert.
		expect(outcome.kind).toBe("executed");
		expect(received).toEqual({});
		if (outcome.kind !== "executed") {
			throw new Error("expected the echo tool to execute");
		}
		expect(outcome.result).toEqual({ done: true });
	});

	it("forwards string tool results without re-parsing", async () => {
		// Arrange: a string result takes the direct-forward branch.
		const grants = createGrantRegistry();
		grants.registerTool("quote", true);
		const entry: CatalogEntry = {
			description: "quote",
			grantedByDefault: true,
			implementation: () => "raw-string-result",
			inputSchema: {},
			name: "quote",
			source: "builtin",
		};
		const allow: ControlPipeline = {
			inspect: (seen) =>
				Promise.resolve({
					blockingControl: undefined,
					content: seen.content,
					flagged: false,
					hits: [],
					redactions: [],
					verdict: "allow",
				}),
		};
		const governor = createToolGovernor({ grants, pipeline: allow });

		// Act.
		const outcome = await governor.governToolCall(entry, {}, "hr");

		// Assert.
		expect(outcome.kind).toBe("executed");
		if (outcome.kind !== "executed") {
			throw new Error("expected the quote tool to execute");
		}
		expect(outcome.result).toBe("raw-string-result");
	});
});

describe("cheapest detector leftover branches", () => {
	it("marks a below-minimum-length IBAN candidate as unvalidated", () => {
		// Arrange: 14 chars match the IBAN shape but fail the length check.

		// Act.
		const found = detectSensitive("ref DE121234567890");

		// Assert.
		const iban = found.find((detection) => detection.type === "iban");
		expect(iban?.validated).toBe(false);
		expect(iban?.confidence).toBe(0.5);
	});

	it("detects a titled known surname via the person.title detector", () => {
		// Arrange: "Herr" is a title in our pattern but not a person signal
		// for the compromise NER tier, so the title span survives dedup.
		// Act.
		const found = detectSensitive("Herr Schmidt");

		// Assert.
		expect(found.some((detection) => detection.detectorId === "person.title")).toBe(true);
	});
});
