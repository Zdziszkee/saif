/**
 * Evaluation suite, part 11 — the durable audit file.
 *
 * Management and security teams do not read test doubles; they read
 * files. The file sink appends one JSON object per line, so standard
 * log tooling (`grep`, `jq`, CSV imports) works unchanged, and restarts
 * keep appending instead of truncating the trail.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditEvent } from "#/control/audit.ts";
import { createFileAuditSink } from "#/control/audit-file.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	const dirs = tempDirs.splice(0, tempDirs.length);
	await Promise.all(dirs.map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("eval: the audit file keeps a parseable trail", () => {
	it("appends one JSON object per recorded event", async () => {
		const dir = await mkdtemp(join(tmpdir(), "saif-eval-audit-"));
		tempDirs.push(dir);
		const path = join(dir, "audit.jsonl");
		const sink = createFileAuditSink(path);
		sink.record(auditEvent("interaction", { groupId: "hr", verdict: "allow" }));
		sink.record(auditEvent("interaction", { controlId: "signatures", verdict: "block" }));

		const lines = (await readFile(path, "utf8")).trim().split("\n");
		expect(lines.length).toBe(2);
		for (const line of lines) {
			const parsed = JSON.parse(line) as { kind?: string; timestamp?: string };
			expect(parsed.kind).toBe("interaction");
			expect(typeof parsed.timestamp).toBe("string");
		}
	});

	it("exposes its path for operators", async () => {
		const dir = await mkdtemp(join(tmpdir(), "saif-eval-audit-"));
		tempDirs.push(dir);
		const path = join(dir, "audit.jsonl");
		const sink = createFileAuditSink(path);
		expect(sink.path).toBe(path);
	});
});
