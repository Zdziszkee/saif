import { createHash } from "node:crypto";
import { readFileSync, watch } from "node:fs";
import { type Policy, policySchema } from "./schema.ts";

/** Debounce for policy file change events before reloading. */
const RELOAD_DEBOUNCE_MS = 100;

/** Truncated sha-256 content hash stamped into audit records. */
const VERSION_HASH_LENGTH = 16;

export interface PolicySnapshot {
	loadedAt: number;
	policy: Policy;
	source: string;
	/** Content hash of the policy file; stamped into audit records. */
	version: string;
}

export type LoadResult =
	| { ok: true; snapshot: PolicySnapshot }
	| { ok: false; errors: string[]; source: string };

/** Load and validate a policy document. Never throws on invalid content. */
export function loadPolicy(source: string): LoadResult {
	let raw: string;
	try {
		raw = readFileSync(source, "utf8");
	} catch (error) {
		return {
			errors: [
				`cannot read policy file: ${error instanceof Error ? error.message : String(error)}`,
			],
			ok: false,
			source,
		};
	}

	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch (error) {
		return {
			errors: [`invalid JSON: ${error instanceof Error ? error.message : String(error)}`],
			ok: false,
			source,
		};
	}

	const parsed = policySchema.safeParse(json);
	if (!parsed.success) {
		return {
			errors: parsed.error.issues.map(
				(issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`,
			),
			ok: false,
			source,
		};
	}

	return {
		ok: true,
		snapshot: {
			loadedAt: Date.now(),
			policy: parsed.data,
			source,
			version: createHash("sha256").update(raw).digest("hex").slice(0, VERSION_HASH_LENGTH),
		},
	};
}

export interface PolicyStore {
	/** Current policy snapshot, or null when no valid policy has been loaded. */
	get(): PolicySnapshot | null;
	/** Validation errors from the most recent failed load, if any. */
	getErrors(): string[];
	/** Re-read the file. Invalid content keeps the last valid policy active. */
	reload(): LoadResult;
	/** Watch the file for changes and reload with a debounce. Returns a stop fn. */
	watch(): () => void;
}

export function createPolicyStore(source: string): PolicyStore {
	let current: PolicySnapshot | null = null;
	let errors: string[] = [];

	function apply(result: LoadResult): LoadResult {
		if (result.ok) {
			current = result.snapshot;
			errors = [];
		} else {
			// Keep the last valid policy active; only record the errors.
			errors = result.errors;
		}
		return result;
	}

	return {
		get: () => current,
		getErrors: () => errors,
		reload: () => apply(loadPolicy(source)),
		watch: () => {
			let timer: ReturnType<typeof setTimeout> | null = null;
			const watcher = watch(source, { persistent: false }, () => {
				if (timer !== null) {
					clearTimeout(timer);
				}
				timer = setTimeout(() => {
					timer = null;
					apply(loadPolicy(source));
				}, RELOAD_DEBOUNCE_MS);
			});
			return () => {
				if (timer !== null) {
					clearTimeout(timer);
				}
				watcher.close();
			};
		},
	};
}
