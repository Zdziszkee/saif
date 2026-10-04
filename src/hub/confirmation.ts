/**
 * Human approval for restricted MCP tool calls via MCP elicitation.
 *
 * Restricted tools (`requireConfirm` in `policy.mcp.json`) must not run on
 * the model's authority alone. The previous protocol answered the first
 * call with `confirmation-required` plus an opaque token and executed
 * nothing — but over MCP that surfaces as a tool *error* the model reads,
 * so no human ever sees an approval prompt (and the model could even
 * self-confirm by echoing the token back).
 *
 * This module adds the human path: the tool handler asks the MCP client to
 * elicit approval (`elicitation/create`, rendered by OpenCode as an
 * approve/decline prompt). Accepting runs exactly the stored call once;
 * declining, cancelling, timing out, or any transport failure denies it and
 * audits the denial — fail closed. Clients that cannot elicit (no
 * capability, sessionless transport) keep the legacy token protocol
 * untouched, so old harnesses behave exactly as before. On era-2026
 * transports the SDK raises `ToolInputRequiredError` instead of waiting; it
 * propagates untouched so the SDK can run its elicitation round trip.
 */

import { ToolInputRequiredError } from "@tanstack/ai-mcp/server";

/** Bound for one approval wait; the call fails closed past it. */
export const ELICITATION_TIMEOUT_MS = 120_000;

/** MCP JSON-RPC "Method not found": the client has no elicitation handler. */
const METHOD_NOT_FOUND = -32_601;
/** SDK capability gate: the client did not declare elicitation support. */
const capabilityNotSupported = "CAPABILITY_NOT_SUPPORTED";
/** Rejection text of the SDK sessionless transport (no open session). */
const SESSIONLESS_HINT = "spec 2025 session";
const elicitationTimeoutMessage = "elicitation timed out waiting for the user";

/** The client's approval prompt callback (`ctx.context.requestInput`). */
export type ApprovalPrompt = (message: string) => Promise<unknown>;

export type HumanApproval =
	| { decision: "approved" }
	| { decision: "denied"; reason: "rejected" | "timed-out" }
	| { decision: "unsupported" };

/**
 * The exact text the human approves. Names the tool and group, bounds the
 * approval to this single call, and never carries the pending token (the
 * model must not be able to approve its own request from tool output).
 */
export function approvalMessage(toolName: string, groupId: string): string {
	return (
		`Tool '${toolName}' for group '${groupId}' needs one-time human approval. ` +
		"Accept to run exactly this call once — the approval cannot be reused or " +
		"retargeted at different arguments. Decline to refuse it."
	);
}

/**
 * True only when elicitation is structurally unavailable: the client
 * answered MethodNotFound, or there is no open session to ask over. Every
 * other failure (decline, cancel, timeout, transport error) is a denial,
 * never a fallback — falling back would hand the model a retryable token
 * after a human-adjacent refusal.
 */
export function isUnsupportedElicitation(error: unknown): boolean {
	if (typeof error !== "object" || error === null) {
		return false;
	}
	const record = error as { code?: unknown; message?: unknown };
	if (record.code === METHOD_NOT_FOUND || record.code === capabilityNotSupported) {
		return true;
	}
	return typeof record.message === "string" && record.message.includes(SESSIONLESS_HINT);
}

/**
 * Ask the human through the MCP client. Resolves `approved` on any accept,
 * `unsupported` when elicitation cannot run (legacy token protocol stays
 * available), and `denied` for every other outcome — including our own
 * timeout, so an unanswered prompt can never hang a tool call forever.
 */
export async function requestHumanApproval(input: {
	message: string;
	requestApproval?: ApprovalPrompt | undefined;
	timeoutMs?: number;
}): Promise<HumanApproval> {
	const runner = input.requestApproval;
	if (runner === undefined) {
		return { decision: "unsupported" };
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			runner(input.message),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(elicitationTimeoutMessage)),
					input.timeoutMs ?? ELICITATION_TIMEOUT_MS,
				);
			}),
		]);
		return { decision: "approved" };
	} catch (error) {
		if (error instanceof ToolInputRequiredError) {
			// Era-2026 path: no live wait exists. Reaching here means the
			// transport already converted the demand into an elicitation
			// round trip — rethrow so the SDK (not us) drives the retry.
			throw error;
		}
		if (isUnsupportedElicitation(error)) {
			return { decision: "unsupported" };
		}
		if (error instanceof Error && error.message === elicitationTimeoutMessage) {
			return { decision: "denied", reason: "timed-out" };
		}
		return { decision: "denied", reason: "rejected" };
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}
