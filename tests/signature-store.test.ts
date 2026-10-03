import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { filterContent } from "#/control/filter.ts";
import { createSignatureStore, type SignatureStore } from "#/control/signature-store.ts";

const WatchPollIntervalMs = 50;
const WatchTimeoutMs = 2000;

async function waitForSignature(store: SignatureStore, id: string): Promise<void> {
	const deadline = Date.now() + WatchTimeoutMs;
	while (!store.snapshot().feed.signatures.some((signature) => signature.id === id)) {
		if (Date.now() >= deadline) {
			throw new Error(`signature ${id} did not appear within timeout`);
		}
		await new Promise<void>((resolve) => setTimeout(resolve, WatchPollIntervalMs));
	}
}
import sampleFeedText from "../signatures.json?raw";

interface TempFeed {
	cleanup(): void;
	path: string;
	write(entries: string[]): void;
}

const cleanups: (() => void)[] = [];

afterEach(() => {
	while (cleanups.length > 0) {
		cleanups.pop()?.();
	}
});

function track(temp: TempFeed): TempFeed {
	cleanups.push(() => temp.cleanup());
	return temp;
}

function tempFeed(entries: string[]): TempFeed {
	const dir = mkdtempSync(join(tmpdir(), "saif-signatures-"));
	const path = join(dir, "signatures.json");
	writeFileSync(path, JSON.stringify(entries.map((entry) => JSON.parse(entry))));
	return {
		cleanup() {
			rmSync(dir, { force: true, recursive: true });
		},
		path,
		write(next) {
			writeFileSync(path, JSON.stringify(next.map((entry) => JSON.parse(entry))));
		},
	};
}

const benignEntry = JSON.stringify({
	addedAt: "2026-10-03T00:00:00.000Z",
	description: "benign filler pattern",
	id: "filler",
	kind: "jailbreak",
	name: "Filler pattern",
	pattern: "filler-pattern-never-matches",
	severity: "low",
	source: "test",
	updatedAt: "2026-10-03T00:00:00.000Z",
});

const injectedEntry = JSON.stringify({
	addedAt: "2026-10-03T00:00:00.000Z",
	description: "freshly added pattern",
	id: "hot-reload-marker",
	kind: "jailbreak",
	name: "Hot-reload marker",
	pattern: "hot-reload-attack-marker",
	severity: "high",
	source: "test",
	updatedAt: "2026-10-03T00:00:00.000Z",
});

const invalidEntry = JSON.stringify({
	addedAt: "2026-10-03T00:00:00.000Z",
	description: "broken regex",
	id: "broken",
	kind: "jailbreak",
	name: "Broken pattern",
	pattern: "([unclosed",
	severity: "high",
	source: "test",
	updatedAt: "2026-10-03T00:00:00.000Z",
});

describe("signature feed store", () => {
	it("loads the shipped sample feed from disk", () => {
		const dir = mkdtempSync(join(tmpdir(), "saif-signatures-"));
		const path = join(dir, "signatures.json");
		writeFileSync(path, sampleFeedText);
		cleanups.push(() => rmSync(dir, { force: true, recursive: true }));
		const store = createSignatureStore(path);
		cleanups.push(() => store.close());
		const snapshot = store.reload();
		expect(snapshot.errors).toEqual([]);
		expect(snapshot.feed.signatures.length).toBeGreaterThan(0);
	});

	it("picks up an added pattern on reload and blocks a matching request", () => {
		const temp = track(tempFeed([benignEntry]));
		const store = createSignatureStore(temp.path);
		cleanups.push(() => store.close());
		store.reload();

		const before = filterContent(
			{ surface: "prompt", text: "hot-reload-attack-marker" },
			{ feed: store.snapshot().feed },
		);
		expect(before.verdict).toBe("allow");

		temp.write([benignEntry, injectedEntry]);
		store.reload();

		const after = filterContent(
			{ surface: "prompt", text: "hot-reload-attack-marker" },
			{ feed: store.snapshot().feed },
		);
		expect(after.verdict).toBe("block");
		expect(after.matches.map((match) => match.signatureId)).toContain("hot-reload-marker");
	});

	it("keeps valid entries active when a reload adds an invalid one", () => {
		const temp = track(tempFeed([benignEntry]));
		const store = createSignatureStore(temp.path);
		cleanups.push(() => store.close());
		temp.write([benignEntry, invalidEntry]);
		const snapshot = store.reload();
		expect(snapshot.feed.signatures.map((signature) => signature.id)).toEqual(["filler"]);
		expect(snapshot.errors.length).toBeGreaterThan(0);
	});
});

describe("signature feed watching", () => {
	it("reflects file edits while watching", async () => {
		const temp = track(tempFeed([benignEntry]));
		const store = createSignatureStore(temp.path, { watch: true });
		cleanups.push(() => store.close());

		temp.write([benignEntry, injectedEntry]);

		await waitForSignature(store, "hot-reload-marker");
	});
});
