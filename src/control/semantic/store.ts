import { rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { sha256Hex } from "#/control/hash.ts";
import {
	parseSemanticConfig,
	SEMANTIC_POLICY_PATH,
	type SemanticConfig,
} from "#/control/semantic/config.ts";
import { SemanticConfigurationError } from "#/control/semantic/errors.ts";

/**
 * File-backed semantic (Jev) reads and writes for the UI-editable controls
 * plane. Mirrors `src/control/policy/store.ts` but for `policy.jev.json`:
 * loads read the live document from disk, validate with
 * `parseSemanticConfig`, stamp the content-hash `semanticVersion`, and saves
 * check the caller's `baseVersion` against the live snapshot (stale writers
 * get 409), then persist atomically (temp file + rename) and reload so the
 * returned snapshot reflects what is on disk.
 */

const JSON_INDENT = 2;
const STATUS_BAD_REQUEST = 400;
const STATUS_CONFLICT = 409;
const STATUS_INTERNAL_ERROR = 500;

/** A validation problem in JSON-safe shape. */
export interface SemanticIssueJson {
	message: string;
	path?: readonly (number | string)[] | undefined;
}

/** Outcome of a semantic save: success carries the reloaded snapshot. */
export type SaveSemanticResult =
	| { config: SemanticConfig; ok: true; semanticVersion: string }
	| { issues: readonly SemanticIssueJson[]; ok: false; status: 400 | 409 | 500 };

/** Outcome of a semantic load. */
export type LoadSemanticResult =
	| { ok: true; snapshot: { config: SemanticConfig; semanticVersion: string } }
	| { issues: readonly SemanticIssueJson[]; ok: false };

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
 * Read the live semantic document: parses `policy.jev.json` from disk, so the
 * snapshot (and its content-hash `semanticVersion`) reflects what is on disk.
 */
export async function loadSemanticSnapshot(
	path: string = SEMANTIC_POLICY_PATH,
): Promise<LoadSemanticResult> {
	let text: string;
	try {
		text = await Bun.file(path).text();
	} catch (error) {
		const detail = error instanceof Error ? error.message : "unreadable";
		return {
			issues: [{ message: `semantic source unavailable: ${detail}` }],
			ok: false,
		};
	}
	let document: unknown;
	try {
		document = JSON.parse(text);
	} catch (error) {
		const detail = error instanceof Error ? error.message : "unreadable";
		return {
			issues: [{ message: `semantic source invalid JSON: ${detail}` }],
			ok: false,
		};
	}
	let config: SemanticConfig;
	try {
		config = parseSemanticConfig(document);
	} catch (error) {
		const detail = error instanceof Error ? error.message : "invalid semantic configuration";
		return { issues: [{ message: detail }], ok: false };
	}
	const semanticVersion = sha256Hex(canonicalJson(document));
	const snapshot = deepFreeze({ config: deepFreeze(config), semanticVersion });
	return { ok: true, snapshot };
}

/**
 * Validate `candidate` and persist it when `baseVersion` still matches the
 * live snapshot. Stale writers get 409 (reload and retry); invalid documents
 * get 400 with the validation message and leave the file untouched. Writes go
 * to a sibling temp file renamed over the target so readers never observe a
 * half-written document.
 */
export async function saveSemanticDocument(
	candidate: unknown,
	baseVersion: string,
	path: string = SEMANTIC_POLICY_PATH,
): Promise<SaveSemanticResult> {
	const current = await loadSemanticSnapshot(path);
	if (!current.ok) {
		return { issues: current.issues, ok: false, status: STATUS_INTERNAL_ERROR };
	}
	if (current.snapshot.semanticVersion !== baseVersion) {
		return {
			issues: [{ message: "semantic configuration changed since baseVersion; reload and retry" }],
			ok: false,
			status: STATUS_CONFLICT,
		};
	}
	let parsed: SemanticConfig;
	try {
		parsed = parseSemanticConfig(candidate);
	} catch (error) {
		if (error instanceof SemanticConfigurationError) {
			return { issues: [{ message: error.message }], ok: false, status: STATUS_BAD_REQUEST };
		}
		const detail = error instanceof Error ? error.message : "unknown error";
		return {
			issues: [{ message: `semantic validation failed: ${detail}` }],
			ok: false,
			status: STATUS_INTERNAL_ERROR,
		};
	}
	const text = `${JSON.stringify(parsed, null, JSON_INDENT)}\n`;
	const temporary = join(dirname(path), `${basename(path)}.tmp.${process.pid}.${Date.now()}`);
	try {
		await writeFile(temporary, text, "utf8");
		await rename(temporary, path);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		const detail = error instanceof Error ? error.message : "unknown error";
		return {
			issues: [{ message: `semantic write failed: ${detail}` }],
			ok: false,
			status: STATUS_INTERNAL_ERROR,
		};
	}
	const reloaded = await loadSemanticSnapshot(path);
	if (!reloaded.ok) {
		return { issues: reloaded.issues, ok: false, status: STATUS_INTERNAL_ERROR };
	}
	return {
		config: reloaded.snapshot.config,
		ok: true,
		semanticVersion: reloaded.snapshot.semanticVersion,
	};
}
