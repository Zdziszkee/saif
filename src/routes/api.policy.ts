import { createFileRoute } from "@tanstack/react-router";
import { loadPolicySnapshot, savePolicyDocument } from "#/control/policy/store.ts";
import { refreshHubAfterPolicyWrite } from "#/hub/runtime.ts";

/**
 * UI-editable policy document (`/api/policy`): `GET` returns the live
 * `{ policy, policyVersion }` snapshot; `POST` accepts
 * `{ policy, baseVersion }`, rejects stale writers with 409 and invalid
 * documents with 400 `{ ok: false, issues }`, and persists valid updates
 * atomically before returning `{ ok: true, policy, policyVersion }`.
 */

const STATUS_BAD_REQUEST = 400;
const STATUS_INTERNAL_ERROR = 500;

async function handleGet(): Promise<Response> {
	const result = await loadPolicySnapshot();
	if (!result.ok) {
		return Response.json({ issues: result.issues, ok: false }, { status: STATUS_INTERNAL_ERROR });
	}
	return Response.json({
		policy: result.snapshot.policy,
		policyVersion: result.snapshot.policyVersion,
	});
}

interface PolicyUpdateBody {
	baseVersion?: unknown;
	policy?: unknown;
}

async function handlePost(request: Request): Promise<Response> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json(
			{ issues: [{ message: "request body is not valid JSON" }], ok: false },
			{ status: STATUS_BAD_REQUEST },
		);
	}
	if (typeof body !== "object" || body === null) {
		return Response.json(
			{
				issues: [{ message: "request body must be an object with policy and baseVersion" }],
				ok: false,
			},
			{ status: STATUS_BAD_REQUEST },
		);
	}
	const { baseVersion, policy } = body as PolicyUpdateBody;
	if (typeof baseVersion !== "string" || baseVersion.length === 0) {
		return Response.json(
			{ issues: [{ message: "baseVersion must be a non-empty string" }], ok: false },
			{ status: STATUS_BAD_REQUEST },
		);
	}
	const result = await savePolicyDocument(policy, baseVersion);
	if (!result.ok) {
		return Response.json({ issues: result.issues, ok: false }, { status: result.status });
	}
	refreshHubAfterPolicyWrite();
	return Response.json({
		ok: true,
		policy: result.policy,
		policyVersion: result.policyVersion,
	});
}

export const Route = createFileRoute("/api/policy")({
	server: {
		handlers: {
			GET: () => handleGet(),
			POST: ({ request }) => handlePost(request),
		},
	},
});
