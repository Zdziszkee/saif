import { createServerFn } from "@tanstack/react-start";
import type { Policy } from "#/control/policy/schema.ts";
import {
	loadPolicySnapshot,
	type SavePolicyResult,
	savePolicyDocument,
} from "#/control/policy/store.ts";
import type { SemanticConfig } from "#/control/semantic/config.ts";
import { loadSemanticSnapshot, saveSemanticDocument } from "#/control/semantic/store.ts";
import { refreshHubAfterPolicyWrite } from "#/hub/runtime.ts";

/**
 * Server-function wrappers over the file-backed policy store for TanStack
 * Start routes: `getPolicyDocument` returns the live
 * `{ policy, policyVersion }` (throwing when no valid policy loads, like
 * `getDashboardData`), and `updatePolicyDocument` validates + persists a
 * candidate, returning the `{ ok }` union so the UI can render 400 issues or
 * 409 stale-version conflicts without catching.
 */

/** The live policy document with its content-hash version stamp. */
export interface PolicyDocument {
	policy: Policy;
	policyVersion: string;
}

export const getPolicyDocument = createServerFn({ method: "GET" }).handler(
	async (): Promise<PolicyDocument> => {
		const result = await loadPolicySnapshot();
		if (!result.ok) {
			const messages = result.issues.map((issue) => issue.message).join("; ");
			throw new Error(`policy unavailable: ${messages}`);
		}
		return { policy: result.snapshot.policy, policyVersion: result.snapshot.policyVersion };
	},
);

export const updatePolicyDocument = createServerFn({ method: "POST" })
	.validator((data: { baseVersion: string; policy: unknown }) => data)
	.handler(async ({ data }): Promise<SavePolicyResult> => {
		const result = await savePolicyDocument(data.policy, data.baseVersion);
		if (result.ok) {
			refreshHubAfterPolicyWrite();
		}
		return result;
	});

/** A validation problem in JSON-safe shape (zod paths may carry symbols). */
export interface JevIssueJson {
	message: string;
	path?: readonly (number | string)[] | undefined;
}

/** Outcome of a Jev save: success carries the reloaded snapshot. */
export type SaveJevResult =
	| { config: SemanticConfig; ok: true; semanticVersion: string }
	| { issues: readonly JevIssueJson[]; ok: false; status: 400 | 409 | 500 };

/** The live Jev document with its content-hash version stamp. */
export interface JevDocument {
	config: SemanticConfig;
	semanticVersion: string;
}

export const getJevDocument = createServerFn({ method: "GET" }).handler(
	async (): Promise<JevDocument> => {
		const result = await loadSemanticSnapshot();
		if (!result.ok) {
			const messages = result.issues.map((issue: { message: string }) => issue.message).join("; ");
			throw new Error(`jev unavailable: ${messages}`);
		}
		return { config: result.snapshot.config, semanticVersion: result.snapshot.semanticVersion };
	},
);

export const updateJevDocument = createServerFn({ method: "POST" })
	.validator((data: { baseVersion: string; config: unknown }) => data)
	.handler(async ({ data }): Promise<SaveJevResult> => {
		const result = await saveSemanticDocument(data.config, data.baseVersion);
		if (result.ok) {
			refreshHubAfterPolicyWrite();
		}
		return result;
	});
