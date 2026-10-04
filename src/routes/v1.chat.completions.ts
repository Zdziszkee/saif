import { createFileRoute } from "@tanstack/react-router";

import { handleChatCompletions } from "#/gateway/gateway.ts";
import { getGatewayDeps } from "#/hub/runtime.ts";

/**
 * OpenAI-compatible LLM gateway (`POST /v1/chat/completions`): agent
 * harnesses point their provider `baseURL` here. Prompts gate through the
 * control pipeline under the caller's identity before reaching the
 * upstream provider; completions stream back untouched.
 */

export const Route = createFileRoute("/v1/chat/completions")({
	server: {
		handlers: {
			POST: async ({ request }) => handleChatCompletions(request, await getGatewayDeps()),
		},
	},
});
