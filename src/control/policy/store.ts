import { rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	FilePolicySource,
	type PolicyIssue,
	PolicyLoader,
	type ReloadResult,
} from "#/control/policy/loader.ts";
import { type Policy, parsePolicy } from "#/control/policy/schema.ts";

/**
 * File-backed policy reads and writes for the UI-editable controls plane.
 * Single source for both the `/api/policy` route handlers and the dashboard
 * `createServerFn` wrappers: loads go through `PolicyLoader` (same
 * `policy.json` path as the hub runtime) and saves validate with
 * `parsePolicy`, check the caller's `baseVersion` against the live snapshot
 * (stale writers get 409), then persist atomically (temp file + rename) and
 * reload so the returned snapshot reflects what is on disk.
 */

const JSON_INDENT = 2;
const POLICY_PATH = "policy.json";
const STATUS_BAD_REQUEST = 400;
const STATUS_CONFLICT = 409;
const STATUS_INTERNAL_ERROR = 500;

/** A validation problem in JSON-safe shape (zod paths may carry symbols). */
export interface PolicyIssueJson {
	message: string;
	path?: readonly (number | string)[] | undefined;
}

/** Outcome of a policy save: success carries the reloaded snapshot. */
export type SavePolicyResult =
	| { ok: true; policy: Policy; policyVersion: string }
	| { issues: readonly PolicyIssueJson[]; ok: false; status: 400 | 409 | 500 };

function toJsonIssue(issue: PolicyIssue): PolicyIssueJson {
	if (issue.path === undefined) {
		return { message: issue.message };
	}
	const path = issue.path.map((segment) => {
		if (typeof segment === "string" || typeof segment === "number") {
			return segment;
		}
		return String(segment);
	});
	return { message: issue.message, path };
}

/**
 * Read the live policy document: a fresh loader over `policy.json`, so the
 * snapshot (and its content-hash `policyVersion`) reflects what is on disk.
 */
export function loadPolicySnapshot(): Promise<ReloadResult> {
	const loader = new PolicyLoader(new FilePolicySource(POLICY_PATH));
	return loader.reload();
}

/**
 * Validate `candidate` and persist it when `baseVersion` still matches the
 * live snapshot. Stale writers get 409 (reload and retry); invalid documents
 * get 400 with the schema issues and leave the file untouched. Writes go to
 * a sibling temp file renamed over `policy.json` so readers never observe a
 * half-written document.
 */
export async function savePolicyDocument(
	candidate: unknown,
	baseVersion: string,
): Promise<SavePolicyResult> {
	const loader = new PolicyLoader(new FilePolicySource(POLICY_PATH));
	const current = await loader.reload();
	if (!current.ok) {
		return {
			issues: current.issues.map(toJsonIssue),
			ok: false,
			status: STATUS_INTERNAL_ERROR,
		};
	}
	if (current.snapshot.policyVersion !== baseVersion) {
		return {
			issues: [{ message: "policy changed since baseVersion; reload and retry" }],
			ok: false,
			status: STATUS_CONFLICT,
		};
	}
	const parsed = parsePolicy(candidate);
	if (!parsed.success) {
		return {
			issues: parsed.issues.map(toJsonIssue),
			ok: false,
			status: STATUS_BAD_REQUEST,
		};
	}
	const text = `${JSON.stringify(parsed.policy, null, JSON_INDENT)}\n`;
	const temporary = join(dirname(POLICY_PATH), `policy.json.tmp.${process.pid}.${Date.now()}`);
	try {
		await writeFile(temporary, text, "utf8");
		await rename(temporary, POLICY_PATH);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		const detail = error instanceof Error ? error.message : "unknown error";
		return {
			issues: [{ message: `policy write failed: ${detail}` }],
			ok: false,
			status: STATUS_INTERNAL_ERROR,
		};
	}
	const reloaded = await loader.reload();
	if (!reloaded.ok) {
		return {
			issues: reloaded.issues.map(toJsonIssue),
			ok: false,
			status: STATUS_INTERNAL_ERROR,
		};
	}
	return {
		ok: true,
		policy: reloaded.snapshot.policy,
		policyVersion: reloaded.snapshot.policyVersion,
	};
}
