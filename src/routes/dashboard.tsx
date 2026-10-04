import { createFileRoute } from "@tanstack/react-router";
import { useCallback } from "react";
import { Dashboard } from "#/components/dashboard/dashboard.tsx";
import { getDashboardData } from "#/dashboard/server.ts";

export const Route = createFileRoute("/dashboard")({
	component: DashboardPage,
	loader: () => getDashboardData(),
});

/**
 * Legacy `/dashboard` entry point: renders the same interactive dashboard as
 * `/` so old links keep working. The audit export links (JSONL/CSV) live in
 * the shared dashboard footer.
 */
function DashboardPage() {
	const data = Route.useLoaderData();
	const onRefresh = useCallback(() => getDashboardData(), []);
	return <Dashboard initialData={data} onRefresh={onRefresh} />;
}
