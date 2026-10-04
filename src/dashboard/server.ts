/**
 * Server-side dashboard read: loads the live policy document through the
 * policy loader and projects it with the live audit sink's recorded events.
 * Server-only reads stay inside this `createServerFn` handler, which the
 * route loader calls directly (and polls).
 */

import { createServerFn } from "@tanstack/react-start";
import { readAuditEvents } from "#/control/audit.ts";
import { FilePolicySource, PolicyLoader } from "#/control/policy/loader.ts";
import { buildDashboardData } from "#/dashboard/data.ts";
import type { DashboardData } from "#/dashboard/types.ts";
import { getAuditSink, getSignatureFeedStore } from "#/hub/runtime.ts";

const POLICY_PATH = "policy.json";

export const getDashboardData = createServerFn({ method: "GET" }).handler(
	async (): Promise<DashboardData> => {
		const loader = new PolicyLoader(new FilePolicySource(POLICY_PATH));
		const result = await loader.reload();
		if (!result.ok) {
			const messages = result.issues.map((issue) => issue.message).join("; ");
			throw new Error(`policy unavailable: ${messages}`);
		}
		let feedVersion = "unavailable";
		try {
			const snapshot = getSignatureFeedStore().snapshot();
			if (snapshot.feed.version.length > 0) {
				feedVersion = snapshot.feed.version;
			}
		} catch {
			feedVersion = "unavailable";
		}
		return buildDashboardData(
			result.snapshot,
			new Date().toISOString(),
			readAuditEvents(getAuditSink()),
			feedVersion,
		);
	},
);
