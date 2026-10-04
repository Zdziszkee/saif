/**
 * MCP tool access policy (`policy.mcp.json`).
 *
 * Separate document from `policy.json` on purpose: `policy.json` owns *how*
 * content is inspected (thresholds, detectors, semantic governance), while
 * this file owns *who may call which tool* — one entry per tool with the
 * allowed caller group ids plus a `requireConfirm` flag that forces an
 * explicit user confirmation before the tool executes.
 *
 * Semantics (fail closed):
 * - Tool listed → only the listed groups may call it.
 * - Tool not listed → denied for every group.
 * - No policy loaded (missing/unreadable file) → the registry abstains and
 *   the hub falls back to its grant-registry defaults, so local dev keeps
 *   working without the file.
 * - Explicit `grant()`/`revoke()` overrides always win over the file, so
 *   operators keep an emergency lever and existing tests keep passing.
 */

import { z } from "zod";
import { sha256Hex } from "#/control/hash.ts";
import { FilePolicySource, type PolicySource } from "#/control/policy/loader.ts";

const toolEntrySchema = z
	.strictObject({
		allowedGroups: z.array(z.string().min(1)).min(1),
		requireConfirm: z.boolean(),
	})
	.superRefine((entry, ctx) => {
		if (new Set(entry.allowedGroups).size !== entry.allowedGroups.length) {
			ctx.addIssue({ code: "custom", message: "allowedGroups contains duplicates" });
		}
	});

/** One document: version plus a tool-name → access-entry map. */
export const toolPolicySchema = z.strictObject({
	tools: z.record(z.string().min(1), toolEntrySchema),
	version: z.string().min(1),
});

export type ToolPolicy = z.infer<typeof toolPolicySchema>;
export type ToolPolicyEntry = z.infer<typeof toolEntrySchema>;

export type ParseToolPolicyResult =
	| { issues: z.core.$ZodIssue[]; success: false }
	| { policy: ToolPolicy; success: true };

/** Validate a tool-policy document. Callers keep the last valid snapshot on failure. */
export function parseToolPolicy(input: unknown): ParseToolPolicyResult {
	const result = toolPolicySchema.safeParse(input);
	if (result.success) {
		return { policy: result.data, success: true };
	}
	return { issues: result.error.issues, success: false };
}

/**
 * Live view of the tool policy used by grants and governance.
 * `allows()` returns `undefined` (abstain) when no policy is loaded so the
 * grant registry can fall through to its defaults; once a document is loaded
 * an unlisted tool is denied.
 */
export interface ToolAccessPolicy {
	allows(groupId: string, toolName: string): boolean | undefined;
	requiresConfirm(toolName: string): boolean;
}

/** Mutable registry: content is swapped on reload, references stay stable. */
export interface ToolPolicyRegistry extends ToolAccessPolicy {
	update(snapshot: ToolPolicySnapshot | undefined): void;
	readonly version: string | undefined;
}

export interface ToolPolicySnapshot {
	readonly policy: ToolPolicy;
	readonly version: string;
}

export function createToolPolicyRegistry(): ToolPolicyRegistry {
	let snapshot: ToolPolicySnapshot | undefined;
	return {
		allows(groupId, toolName) {
			const policy = snapshot?.policy;
			if (policy === undefined) {
				return;
			}
			const entry = policy.tools[toolName];
			if (entry === undefined) {
				return false;
			}
			return entry.allowedGroups.includes(groupId);
		},
		requiresConfirm(toolName) {
			return snapshot?.policy.tools[toolName]?.requireConfirm ?? false;
		},
		update(next) {
			snapshot = next;
		},
		get version() {
			return snapshot?.version;
		},
	};
}

/** Reported validation problem, shaped like a zod issue. */
export interface ToolPolicyIssue {
	readonly message: string;
	readonly path?: readonly PropertyKey[] | undefined;
}

export type ToolPolicyReloadResult =
	| { issues: readonly ToolPolicyIssue[]; ok: false }
	| { ok: true; snapshot: ToolPolicySnapshot };

/**
 * Loads and hot-reloads the tool-policy document: immutable snapshots swapped
 * atomically on every valid load, last valid snapshot kept when a load fails
 * or a document is invalid. Never throws on missing content — callers treat
 * "no snapshot yet" as abstain.
 */
export class ToolPolicyStore {
	readonly #source: PolicySource;
	#current: ToolPolicySnapshot | undefined;
	#unwatch: (() => void) | undefined;

	constructor(source: PolicySource) {
		this.#source = source;
	}

	get snapshot(): ToolPolicySnapshot | undefined {
		return this.#current;
	}

	/** Initial load plus watcher registration; returns the initial result. */
	async start(): Promise<ToolPolicyReloadResult> {
		const result = await this.#refresh();
		this.#unwatch = this.#source.watch(() => {
			this.#refresh().catch(() => undefined);
		});
		return result;
	}

	/** Explicit reload, e.g. after an edit or to retry a failed load. */
	reload(): Promise<ToolPolicyReloadResult> {
		return this.#refresh();
	}

	stop(): void {
		if (this.#unwatch !== undefined) {
			this.#unwatch();
			this.#unwatch = undefined;
		}
	}

	async #refresh(): Promise<ToolPolicyReloadResult> {
		let document: unknown;
		try {
			document = await this.#source.load();
		} catch (error) {
			const message = error instanceof Error ? error.message : "unreadable";
			return { issues: [{ message: `tool policy source unavailable: ${message}` }], ok: false };
		}
		const parsed = parseToolPolicy(document);
		if (!parsed.success) {
			return { issues: parsed.issues, ok: false };
		}
		const version = sha256Hex(JSON.stringify(document));
		const snapshot: ToolPolicySnapshot = { policy: parsed.policy, version };
		this.#current = snapshot;
		return { ok: true, snapshot };
	}
}

/** File-backed store with the default path, for product wiring. */
export function createFileToolPolicyStore(path: string): ToolPolicyStore {
	return new ToolPolicyStore(new FilePolicySource(path));
}
