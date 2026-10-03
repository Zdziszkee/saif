import { createFileRoute } from "@tanstack/react-router";

import { handleGuardRequest } from "#/control/guard-api.ts";
import { createSignatureStore } from "#/control/signature-store.ts";

const signatureStore = createSignatureStore("signatures.json", { watch: true });

export const Route = createFileRoute("/api/guard")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				let payload: unknown;
				try {
					payload = await request.json();
				} catch {
					return Response.json(
						{ error: "invalid_request", reason: "body must be valid JSON" },
						{ status: 400 },
					);
				}
				const response = handleGuardRequest(payload, {
					feed: signatureStore.snapshot().feed,
				});
				return Response.json(response.body, { status: response.status });
			},
		},
	},
});
