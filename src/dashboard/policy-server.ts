import { createServerFn } from "@tanstack/react-start";
import type { Policy } from "#/control/policy/schema.ts";
import {
	loadPolicySnapshot,
	type SavePolicyResult,
	savePolicyDocument,
} from "#/control/policy/store.ts";
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
