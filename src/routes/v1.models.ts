// biome-ignore-all lint/style/useNamingConvention: OpenAI wire-format keys are snake_case by specification.
import { createFileRoute } from "@tanstack/react-router";

import { FilePolicySource, PolicyLoader } from "#/control/policy/loader.ts";
import { HTTP_SERVICE_UNAVAILABLE, openAiError } from "#/gateway/lifecycle.ts";

const MS_PER_SECOND = 1000;

/**
 * OpenAI model catalog (`GET /v1/models`): the policy allowlist in the
 * `{object: "list", data: [{id, object: "model", ...}]}` shape agent
 * harnesses expect. OpenCode's OpenAI-compatible provider calls this on
 * setup; without it the provider fails with a bare "Not Found" before any
 * chat request is ever sent. Ids are the exact allowlisted model names,
 * so every id listed here passes the gateway allowlist check.
 */

const POLICY_PATH = "policy.json";

const modelsPolicyLoader = new PolicyLoader(new FilePolicySource(POLICY_PATH));
let modelsPolicyStarted = false;

async function getAllowlistedNames(): Promise<readonly string[] | undefined> {
	if (!modelsPolicyStarted) {
		modelsPolicyStarted = true;
		await modelsPolicyLoader.start();
	}
	return modelsPolicyLoader.snapshot?.policy.controls.allowlist.models.map((model) => model.name);
}

async function handle(): Promise<Response> {
	const names = await getAllowlistedNames();
	if (names === undefined) {
		return openAiError(
			HTTP_SERVICE_UNAVAILABLE,
			"policy is unavailable",
			"server_error",
			"policy-unavailable",
		);
	}
	return Response.json({
		data: names.map((id) => ({
			created: Math.floor(Date.now() / MS_PER_SECOND),
			id,
			object: "model",
			owned_by: "saif",
		})),
		object: "list",
	});
}

export const Route = createFileRoute("/v1/models")({
	server: {
		handlers: {
			GET: () => handle(),
		},
	},
});
