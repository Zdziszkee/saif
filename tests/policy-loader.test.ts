import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PolicySource } from "#/control/policy/loader.ts";
import { FilePolicySource, PolicyLoader } from "#/control/policy/loader.ts";
import { cloneBase } from "./policy-fixtures.ts";

class FakePolicySource implements PolicySource {
	#document: unknown;
	#failLoad = false;
	#listener: (() => void) | undefined;

	constructor(document: unknown) {
		this.#document = document;
	}

	load(): Promise<unknown> {
		if (this.#failLoad) {
			return Promise.reject(new Error("unreadable"));
		}
		return Promise.resolve(this.#document);
	}

	watch(onChange: () => void): () => void {
		this.#listener = onChange;
		return () => {
			this.#listener = undefined;
		};
	}

	setDocument(document: unknown): void {
		this.#document = document;
		this.#listener?.();
	}

	setFailLoad(fail: boolean): void {
		this.#failLoad = fail;
	}
}

const HEX_HASH = /^[0-9a-f]{64}$/;
const POLL_INTERVAL_MS = 20;

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	if (predicate()) {
		return;
	}
	if (timeoutMs <= 0) {
		throw new Error("condition not met in time");
	}
	await new Promise((resolve) => {
		setTimeout(resolve, POLL_INTERVAL_MS);
	});
	await waitFor(predicate, timeoutMs - POLL_INTERVAL_MS);
}

function settle(ms = 60): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function documentAtVersion(version: string) {
	const document = cloneBase();
	document.version = version;
	return document;
}

describe("PolicyLoader: load and swap", () => {
	it("loads an initial valid document and stamps a content-hash version", async () => {
		const source = new FakePolicySource(documentAtVersion("1"));
		const loader = new PolicyLoader(source);
		const result = await loader.start();
		expect(result.ok).toBe(true);
		expect(loader.snapshot?.policyVersion).toMatch(HEX_HASH);
		expect(loader.snapshot?.policy.version).toBe("1");
	});

	it("stamps different documents with different versions", async () => {
		const source = new FakePolicySource(documentAtVersion("1"));
		const loader = new PolicyLoader(source);
		await loader.start();
		const firstVersion = loader.snapshot?.policyVersion;
		source.setDocument(documentAtVersion("2"));
		const result = await loader.reload();
		expect(result.ok).toBe(true);
		expect(loader.snapshot?.policyVersion).not.toBe(firstVersion);
		expect(loader.snapshot?.policy.version).toBe("2");
	});

	it("fails closed when no valid policy exists yet", async () => {
		const source = new FakePolicySource({ invalid: true });
		const loader = new PolicyLoader(source);
		const result = await loader.start();
		expect(result.ok).toBe(false);
		expect(loader.snapshot).toBeUndefined();
	});

	it("keeps the last valid snapshot when an edit is invalid", async () => {
		const source = new FakePolicySource(documentAtVersion("1"));
		const loader = new PolicyLoader(source);
		await loader.start();
		const pinned = loader.snapshot;
		source.setDocument({ invalid: true });
		const result = await loader.reload();
		expect(result.ok).toBe(false);
		expect(loader.snapshot).toBe(pinned);
		expect(loader.snapshot?.policy.version).toBe("1");
	});
});

describe("PolicyLoader: hot reload and lifecycle", () => {
	it("applies live edits through the watcher", async () => {
		const source = new FakePolicySource(documentAtVersion("1"));
		const loader = new PolicyLoader(source);
		await loader.start();
		source.setDocument(documentAtVersion("2"));
		await waitFor(() => loader.snapshot?.policy.version === "2");
		expect(loader.snapshot?.policy.version).toBe("2");
	});

	it("keeps the last valid snapshot when a live edit is invalid", async () => {
		const source = new FakePolicySource(documentAtVersion("1"));
		const loader = new PolicyLoader(source);
		await loader.start();
		const pinned = loader.snapshot;
		source.setDocument({ invalid: true });
		await settle();
		expect(loader.snapshot).toBe(pinned);
	});

	it("does not reload after stop", async () => {
		const source = new FakePolicySource(documentAtVersion("1"));
		const loader = new PolicyLoader(source);
		await loader.start();
		loader.stop();
		source.setDocument(documentAtVersion("2"));
		await settle();
		expect(loader.snapshot?.policy.version).toBe("1");
	});

	it("keeps the last valid snapshot when the source becomes unreadable", async () => {
		const source = new FakePolicySource(documentAtVersion("1"));
		const loader = new PolicyLoader(source);
		await loader.start();
		const pinned = loader.snapshot;
		source.setFailLoad(true);
		const result = await loader.reload();
		expect(result.ok).toBe(false);
		expect(loader.snapshot).toBe(pinned);
	});

	it("freezes snapshots so pinned policies cannot change", async () => {
		const source = new FakePolicySource(documentAtVersion("1"));
		const loader = new PolicyLoader(source);
		await loader.start();
		const snapshot = loader.snapshot;
		if (snapshot === undefined) {
			throw new Error("expected a snapshot");
		}
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.policy)).toBe(true);
	});
});

describe("FilePolicySource: real file hot reload", () => {
	it("reloads on file edit and rolls back invalid edits", async () => {
		const directory = await mkdtemp(join(tmpdir(), "policy-loader-"));
		const path = join(directory, "policy.json");
		await writeFile(path, JSON.stringify(documentAtVersion("1")), "utf8");
		const loader = new PolicyLoader(new FilePolicySource(path));
		try {
			await loader.start();
			expect(loader.snapshot?.policy.version).toBe("1");
			await writeFile(path, JSON.stringify(documentAtVersion("2")), "utf8");
			await waitFor(() => loader.snapshot?.policy.version === "2");
			await writeFile(path, "{ not json", "utf8");
			await settle();
			expect(loader.snapshot?.policy.version).toBe("2");
		} finally {
			loader.stop();
			await rm(directory, { force: true, recursive: true });
		}
	});
});
