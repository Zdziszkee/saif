import { createFileRoute, redirect } from "@tanstack/react-router";

function validateDashboardSearch(search: Record<string, unknown>): {
	consumer: string | undefined;
	role: string | undefined;
} {
	const { consumer: rawConsumer, role: rawRole } = search;
	return {
		consumer: typeof rawConsumer === "string" && rawConsumer.length > 0 ? rawConsumer : undefined,
		role: typeof rawRole === "string" && rawRole.length > 0 ? rawRole : undefined,
	};
}

/**
 * `/dashboard` is a legacy path (formerly the Activity page). It now
 * redirects to `/` (Overview), forwarding validated `?consumer=`/`?role=`
 * search params so existing bookmarks keep their scope.
 */
export const Route = createFileRoute("/dashboard")({
	beforeLoad: ({ search }) => {
		throw redirect({ search, to: "/" });
	},
	validateSearch: validateDashboardSearch,
});
