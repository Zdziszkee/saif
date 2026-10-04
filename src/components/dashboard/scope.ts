import { useCallback, useEffect, useState } from "react";
import { matchesPerson } from "#/components/dashboard/persons.ts";
import { ALL_CONSUMERS, type DashboardData, type EscalationRow } from "#/dashboard/types.ts";

export const ALL_ROLES = "all";

const UNKNOWN_ROLE = "unknown";

/**
 * Consumer scope state for the dashboard dropdown. The route's `?consumer=`
 * search param is the source of truth: `initialConsumer` seeds the state and
 * resyncs it whenever the route selection changes, while dropdown changes
 * update local state immediately and report through `onConsumerChange` so the
 * route can navigate (set or clear `?consumer=`).
 */
export function useConsumerScope(
	initialConsumer: string | undefined,
	onConsumerChange: ((next: string) => void) | undefined,
): { consumer: string; handleConsumerChange: (next: string) => void } {
	const [consumer, setConsumer] = useState<string>(initialConsumer ?? ALL_CONSUMERS);

	useEffect(() => {
		if (initialConsumer !== undefined) {
			setConsumer(initialConsumer);
		}
	}, [initialConsumer]);

	const handleConsumerChange = useCallback(
		(next: string) => {
			setConsumer(next);
			onConsumerChange?.(next);
		},
		[onConsumerChange],
	);

	return { consumer, handleConsumerChange };
}

/**
 * Role scope state for the people filter. Mirrors `useConsumerScope`: the
 * route's `?role=` search param is the source of truth, `initialRole` seeds
 * the state and resyncs it whenever the route selection changes, while
 * dropdown changes update local state immediately and report through
 * `onRoleChange` so the route can navigate (set or clear `?role=`). Without
 * the callback the dropdown stays purely local.
 */
export function useRoleScope(
	initialRole: string | undefined,
	onRoleChange: ((next: string) => void) | undefined,
): { handleRoleChange: (next: string) => void; role: string } {
	const [role, setRole] = useState<string>(initialRole ?? ALL_ROLES);

	useEffect(() => {
		if (initialRole !== undefined) {
			setRole(initialRole);
		}
	}, [initialRole]);

	const handleRoleChange = useCallback(
		(next: string) => {
			setRole(next);
			onRoleChange?.(next);
		},
		[onRoleChange],
	);

	return { handleRoleChange, role };
}

/** Distinct roles in use, sorted for the filter dropdown. */
export function distinctRoles(personRoles: Readonly<Record<string, string>>): string[] {
	return [...new Set(Object.values(personRoles))].sort((left, right) => left.localeCompare(right));
}

export interface PeopleTableRow {
	allow: number;
	block: number;
	escalate: number;
	groupId: string;
	redact: number;
	total: number;
	userId: string;
}

/** People rows from the by-consumer verdicts, filtered and sorted by total desc. */
export function toPeopleRows(
	byConsumer: DashboardData["byConsumer"],
	personRoles: Readonly<Record<string, string>>,
	query: string,
	role: string,
): PeopleTableRow[] {
	return Object.entries(byConsumer)
		.map(([userId, metrics]) => ({
			allow: metrics.verdicts.allow,
			block: metrics.verdicts.block,
			escalate: metrics.verdicts.escalate,
			groupId: personRoles[userId] ?? UNKNOWN_ROLE,
			redact: metrics.verdicts.redact,
			total:
				metrics.verdicts.allow +
				metrics.verdicts.redact +
				metrics.verdicts.block +
				metrics.verdicts.escalate,
			userId,
		}))
		.filter(
			(row) => (role === ALL_ROLES || row.groupId === role) && matchesPerson(row.userId, query),
		)
		.sort((left, right) => right.total - left.total);
}

/**
 * Scope escalation rows to one role. A row matches when its subject is the
 * role or when its consumer maps to the role, so both group-attributed and
 * legacy consumer-attributed rows stay visible under their role.
 */
export function filterEscalationsByRole(
	rows: readonly EscalationRow[],
	role: string,
	personRoles: Readonly<Record<string, string>>,
): readonly EscalationRow[] {
	if (role === ALL_ROLES) {
		return rows;
	}
	return rows.filter(
		(row) => row.subject === role || (personRoles[row.consumerKey] ?? "") === role,
	);
}
