/**
 * Server-side dashboard read: loads the live policy document through the
 * policy loader and projects it with the seeded metrics. This is the seam
 * where the metrics/audit queries (tasks 10.2-10.3) plug in later.
 */

import { createServerFn } from "@tanstack/react-start";
import { FilePolicySource, PolicyLoader } from "#/control/policy/loader.ts";
import { buildDashboardData } from "#/dashboard/data.ts";
import type { DashboardData } from "#/dashboard/types.ts";

const POLICY_PATH = "policy.json";

export const getDashboardData = createServerFn({ method: "GET" }).handler(
	async (): Promise<DashboardData> => {
		const loader = new PolicyLoader(new FilePolicySource(POLICY_PATH));
		const result = await loader.reload();
		if (!result.ok) {
			const messages = result.issues.map((issue) => issue.message).join("; ");
			throw new Error(`policy unavailable: ${messages}`);
		}
		return buildDashboardData(result.snapshot, new Date().toISOString());
	},
);
