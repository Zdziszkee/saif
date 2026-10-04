import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSemanticSnapshot, saveSemanticDocument } from "#/control/semantic/store.ts";
import semanticDocument from "../policy.jev.json" with { type: "json" };

function cloneSemanticDocument(): Record<string, unknown> {
	const clone: Record<string, unknown> = JSON.parse(JSON.stringify(semanticDocument));
	return clone;
}

async function writeBaseDocument(
	directory: string,
): Promise<{ base: Record<string, unknown>; path: string }> {
	const path = join(directory, "policy.jev.json");
	const base = cloneSemanticDocument();
	await writeFile(path, JSON.stringify(base), "utf8");
	return { base, path };
}

describe("semantic store", () => {
	it("save-then-load roundtrip preserves the version change", async () => {
		const directory = await mkdtemp(join(tmpdir(), "semantic-store-"));
		try {
			const { base, path } = await writeBaseDocument(directory);
			const loaded = await loadSemanticSnapshot(path);
			if (!loaded.ok) {
				throw new Error("expected the initial load to succeed");
			}
			const baseVersion = loaded.snapshot.semanticVersion;
			const saved = await saveSemanticDocument({ ...base, timeoutMs: 9999 }, baseVersion, path);
			if (!saved.ok) {
				throw new Error(`expected the save to succeed: ${JSON.stringify(saved.issues)}`);
			}
			expect(saved.semanticVersion).not.toBe(baseVersion);
			expect(saved.config.timeoutMs).toBe(9999);
			const reloaded = await loadSemanticSnapshot(path);
			if (!reloaded.ok) {
				throw new Error("expected the reload to succeed");
			}
			expect(reloaded.snapshot.semanticVersion).toBe(saved.semanticVersion);
			expect(reloaded.snapshot.config.timeoutMs).toBe(9999);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	it("rejects a stale baseVersion with 409 and leaves the file untouched", async () => {
		const directory = await mkdtemp(join(tmpdir(), "semantic-store-"));
		try {
			const { base, path } = await writeBaseDocument(directory);
			const loaded = await loadSemanticSnapshot(path);
			if (!loaded.ok) {
				throw new Error("expected the initial load to succeed");
			}
			const firstVersion = loaded.snapshot.semanticVersion;
			const firstSave = await saveSemanticDocument(
				{ ...base, timeoutMs: 9999 },
				firstVersion,
				path,
			);
			if (!firstSave.ok) {
				throw new Error("expected the first save to succeed");
			}
			const stale = await saveSemanticDocument({ ...base, timeoutMs: 8888 }, firstVersion, path);
			if (stale.ok) {
				throw new Error("expected a stale save to fail");
			}
			expect(stale.status).toBe(409);
			const current = await loadSemanticSnapshot(path);
			if (!current.ok) {
				throw new Error("expected the final load to succeed");
			}
			expect(current.snapshot.semanticVersion).toBe(firstSave.semanticVersion);
			expect(current.snapshot.config.timeoutMs).toBe(9999);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	it("rejects an invalid candidate with 400 and leaves the file untouched", async () => {
		const directory = await mkdtemp(join(tmpdir(), "semantic-store-"));
		try {
			const { path } = await writeBaseDocument(directory);
			const loaded = await loadSemanticSnapshot(path);
			if (!loaded.ok) {
				throw new Error("expected the initial load to succeed");
			}
			const baseVersion = loaded.snapshot.semanticVersion;
			const bad = await saveSemanticDocument({ invalid: true }, baseVersion, path);
			if (bad.ok) {
				throw new Error("expected an invalid save to fail");
			}
			expect(bad.status).toBe(400);
			expect(bad.issues.length).toBeGreaterThan(0);
			const current = await loadSemanticSnapshot(path);
			if (!current.ok) {
				throw new Error("expected the final load to succeed");
			}
			expect(current.snapshot.semanticVersion).toBe(baseVersion);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});
});
