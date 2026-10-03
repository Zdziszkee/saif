import { createFileRoute } from "@tanstack/react-router";

import { handleGuardRequest } from "#/control/guard-api.ts";
import { createSignatureStore } from "#/control/signature-store.ts";
import { createPiiVault } from "#/control/vault.ts";

const signatureStore = createSignatureStore("signatures.json", { watch: true });
const { VAULT_SECRET } = process.env;
const serverVault = VAULT_SECRET === undefined ? null : createPiiVault(VAULT_SECRET);

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
				const snapshot = signatureStore.snapshot();
				const response = handleGuardRequest(payload, {
					feed: snapshot.feed,
					feedOk: snapshot.ok,
					vault: serverVault,
				});
				return Response.json(response.body, { status: response.status });
			},
		},
	},
});
