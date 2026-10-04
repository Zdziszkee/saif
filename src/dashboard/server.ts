/**
 * Server-side dashboard read: loads the live policy document through the
 * policy loader and projects it with the live audit sink's recorded events.
 * Server-only reads stay inside this `createServerFn` handler, which the
 * route loader calls directly (and polls).
 */

import { createServerFn } from "@tanstack/react-start";
import { readAuditEvents } from "#/control/audit.ts";
import { FilePolicySource, PolicyLoader } from "#/control/policy/loader.ts";
import { loadSemanticSnapshot } from "#/control/semantic/store.ts";
import { buildDashboardData } from "#/dashboard/data.ts";
import type { DashboardData } from "#/dashboard/types.ts";
import { getDb } from "#/db/index.ts";
import { createGatewayStore } from "#/db/repositories.ts";
import type { GatewayUsageRow } from "#/gateway/store.ts";
import {
	getActiveSemanticConfig,
	getAuditSink,
	getHubStatus,
	getSignatureFeedStore,
} from "#/hub/runtime.ts";

const POLICY_PATH = "policy.json";
const USAGE_POLL_CURSOR = 0;
const USAGE_POLL_LIMIT = 5000;

/** Plain row the dashboard data builder aggregates per user. */
interface UsageRowInput {
	completionTokens: number;
	costUsd: number | null;
	model: string;
	promptTokens: number;
	userId: string;
}

function toUsageRowInput(row: GatewayUsageRow): UsageRowInput | undefined {
	if (row.userId === null) {
		return;
	}
	return {
		completionTokens: row.completionTokens,
		costUsd: row.costUsd,
		model: row.model,
		promptTokens: row.promptTokens,
		userId: row.userId,
	};
}

/**
 * Usage rows for the per-user token card. Never rejects: any store failure
 * resolves to an empty list so the dashboard degrades to an empty usage
 * card instead of failing the read.
 */
function loadUsageRows(): Promise<UsageRowInput[]> {
	return Promise.resolve()
		.then(() => createGatewayStore(getDb()).poll(USAGE_POLL_CURSOR, USAGE_POLL_LIMIT))
		.then((page) => {
			const collected: UsageRowInput[] = [];
			for (const row of page.usage) {
				const projected = toUsageRowInput(row);
				if (projected !== undefined) {
					collected.push(projected);
				}
			}
			return collected;
		})
		.catch(() => []);
}

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
		let semanticVersion = "unavailable";
		try {
			const semantic = await loadSemanticSnapshot();
			if (semantic.ok && semantic.snapshot.semanticVersion.length > 0) {
				semanticVersion = semantic.snapshot.semanticVersion;
			}
		} catch {
			semanticVersion = "unavailable";
		}
		// Live semantic row: the active check count plus the tier mode the hub
		// actually built (live/mock/off), so the dashboard never pins the
		// import-time defaults. A hub-status failure degrades to off rather
		// than failing the dashboard read.
		let semanticMode: "live" | "mock" | "off" = "off";
		try {
			const status = await getHubStatus();
			semanticMode = status.semantic.mode ?? (status.semantic.enabled ? "live" : "off");
		} catch {
			semanticMode = "off";
		}
		const usageRows = await loadUsageRows();
		return buildDashboardData(
			result.snapshot,
			new Date().toISOString(),
			readAuditEvents(getAuditSink()),
			{
				feedVersion,
				semantic: { count: getActiveSemanticConfig().checks.length, mode: semanticMode },
				semanticVersion,
			},
			usageRows,
		);
	},
);
