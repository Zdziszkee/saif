import { createFileRoute } from "@tanstack/react-router";
import { loadSemanticSnapshot, saveSemanticDocument } from "#/control/semantic/store.ts";
import { refreshHubAfterPolicyWrite } from "#/hub/runtime.ts";

/**
 * UI-editable Jev document (`/api/jev`): `GET` returns the live
 * `{ config, semanticVersion }` snapshot; `POST` accepts
 * `{ config, baseVersion }`, rejects stale writers with 409 and invalid
 * documents with 400 `{ ok: false, issues }`, and persists valid updates
 * atomically before returning `{ ok: true, config, semanticVersion }`.
 */

const STATUS_BAD_REQUEST = 400;
const STATUS_INTERNAL_ERROR = 500;

async function handleGet(): Promise<Response> {
	const result = await loadSemanticSnapshot();
	if (!result.ok) {
		return Response.json({ issues: result.issues, ok: false }, { status: STATUS_INTERNAL_ERROR });
	}
	return Response.json({
		config: result.snapshot.config,
		semanticVersion: result.snapshot.semanticVersion,
	});
}

interface JevUpdateBody {
	baseVersion?: unknown;
	config?: unknown;
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
				issues: [{ message: "request body must be an object with config and baseVersion" }],
				ok: false,
			},
			{ status: STATUS_BAD_REQUEST },
		);
	}
	const { baseVersion, config } = body as JevUpdateBody;
	if (typeof baseVersion !== "string" || baseVersion.length === 0) {
		return Response.json(
			{ issues: [{ message: "baseVersion must be a non-empty string" }], ok: false },
			{ status: STATUS_BAD_REQUEST },
		);
	}
	const result = await saveSemanticDocument(config, baseVersion);
	if (!result.ok) {
		return Response.json({ issues: result.issues, ok: false }, { status: result.status });
	}
	refreshHubAfterPolicyWrite();
	return Response.json({
		config: result.config,
		ok: true,
		semanticVersion: result.semanticVersion,
	});
}

export const Route = createFileRoute("/api/jev")({
	server: {
		handlers: {
			GET: () => handleGet(),
			POST: ({ request }) => handlePost(request),
		},
	},
});
