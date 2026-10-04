import { watch } from "node:fs";
import { sha256Hex } from "#/control/hash.ts";
import type { Policy } from "#/control/policy/schema.ts";
import { parsePolicy } from "#/control/policy/schema.ts";

/** A validated policy pinned to one load, with its content-hash version stamp. */
export interface PolicySnapshot {
	readonly policy: Policy;
	readonly policyVersion: string;
}

/** Where the loader reads policy documents and how it observes changes. */
export interface PolicySource {
	load(): Promise<unknown>;
	watch(onChange: () => void): () => void;
}

/** A reported validation problem, shaped like a zod issue. */
export interface PolicyIssue {
	readonly message: string;
	readonly path?: readonly PropertyKey[] | undefined;
}

export type ReloadResult =
	| { ok: true; snapshot: PolicySnapshot }
	| { ok: false; issues: readonly PolicyIssue[] };

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value).sort(([left], [right]) => {
			if (left === right) {
				return 0;
			}
			return left < right ? -1 : 1;
		});
		return `{${entries
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const item of Object.values(value)) {
			deepFreeze(item);
		}
	}
	return value;
}

/**
 * Serves the active policy document from a JSON file and hot-reloads on change.
 */
export class FilePolicySource implements PolicySource {
	readonly #path: string;

	constructor(path: string) {
		this.#path = path;
	}

	async load(): Promise<unknown> {
		const text = await Bun.file(this.#path).text();
		const document: unknown = JSON.parse(text);
		return document;
	}

	watch(onChange: () => void): () => void {
		const watcher = watch(this.#path, { persistent: false }, () => {
			onChange();
		});
		return () => {
			watcher.close();
		};
	}
}

/**
 * Loads and hot-reloads policy documents: immutable snapshots swapped
 * atomically on every valid load, keeping the last valid policy active when a
 * load fails or a document is invalid. With no valid policy ever loaded the
 * snapshot is undefined and the caller must accept no governed traffic.
 */
export class PolicyLoader {
	readonly #source: PolicySource;
	#current: PolicySnapshot | undefined;
	#unwatch: (() => void) | undefined;

	constructor(source: PolicySource) {
		this.#source = source;
	}

	get snapshot(): PolicySnapshot | undefined {
		return this.#current;
	}

	/** Initial load plus watcher registration; returns the initial result. */
	async start(): Promise<ReloadResult> {
		const result = await this.#refresh();
		this.#unwatch = this.#source.watch(() => {
			this.#refresh().catch(() => undefined);
		});
		return result;
	}

	/** Explicit reload, e.g. after an edit or to retry a failed load. */
	reload(): Promise<ReloadResult> {
		return this.#refresh();
	}

	stop(): void {
		if (this.#unwatch !== undefined) {
			this.#unwatch();
			this.#unwatch = undefined;
		}
	}

	async #refresh(): Promise<ReloadResult> {
		let document: unknown;
		try {
			document = await this.#source.load();
		} catch (error) {
			const message = error instanceof Error ? error.message : "unreadable";
			return {
				issues: [{ message: `policy source unavailable: ${message}` }],
				ok: false,
			};
		}
		const parsed = parsePolicy(document);
		if (!parsed.success) {
			return { issues: parsed.issues, ok: false };
		}
		const policyVersion = sha256Hex(canonicalJson(document));
		const snapshot: PolicySnapshot = deepFreeze({
			policy: deepFreeze(parsed.policy),
			policyVersion,
		});
		this.#current = snapshot;
		return { ok: true, snapshot };
	}
}
