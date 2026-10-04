import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { ActivitySections } from "#/components/dashboard/activity-sections.tsx";
import { Dashboard } from "#/components/dashboard/dashboard.tsx";
import { getDashboardData } from "#/dashboard/server.ts";
import { ALL_CONSUMERS } from "#/dashboard/types.ts";

function validateSearch(search: Record<string, unknown>): {
	consumer: string | undefined;
	role: string | undefined;
} {
	const { consumer: rawConsumer, role: rawRole } = search;
	return {
		consumer: typeof rawConsumer === "string" && rawConsumer.length > 0 ? rawConsumer : undefined,
		role: typeof rawRole === "string" && rawRole.length > 0 ? rawRole : undefined,
	};
}

export const Route = createFileRoute("/")({
	component: DashboardPage,
	loader: () => getDashboardData(),
	validateSearch,
});

const ALL_ROLES = "all";

function DashboardPage() {
	const data = Route.useLoaderData();
	const { consumer, role } = Route.useSearch();
	const navigate = useNavigate({ from: "/" });
	const onRefresh = useCallback(() => getDashboardData(), []);
	return (
		<>
			<Dashboard
				initialConsumer={consumer}
				initialData={data}
				initialRole={role}
				onConsumerChange={(next) => {
					navigate({
						search: { consumer: next === ALL_CONSUMERS ? undefined : next, role },
						to: "/",
					}).catch(() => undefined);
				}}
				onRefresh={onRefresh}
				onRoleChange={(next) => {
					navigate({
						search: { consumer, role: next === ALL_ROLES ? undefined : next },
						to: "/",
					}).catch(() => undefined);
				}}
				variant="overview"
			/>
			<div className="mx-auto w-full max-w-6xl px-6 pb-6">
				<ActivitySections consumer={consumer} data={data} role={role} />
			</div>
		</>
	);
}
