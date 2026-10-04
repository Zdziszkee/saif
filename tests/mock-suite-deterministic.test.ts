import { describe, expect, it } from "bun:test";
import { createAllowlistControl } from "#/control/allowlist.ts";
import { createDeterministicControl } from "#/control/deterministic/control.ts";
import { guardInteraction } from "#/control/guard.ts";
import { handleGuardRequest } from "#/control/guard-api.ts";
import { createControlPipeline } from "#/control/pipeline.ts";
import { type Policy, parsePolicy } from "#/control/policy/schema.ts";
import { MAX_CONTENT_LENGTH } from "#/control/shape.ts";
import type { ControlPipeline, Interaction } from "#/control/types.ts";
import { type GatewayDeps, handleChatCompletions } from "#/gateway/gateway.ts";
import type { FetchLike } from "#/gateway/openai.ts";
import { UsageLedger } from "#/gateway/usage.ts";
import policyDocument from "../policy.json" with { type: "json" };
import { auditSink, identityResolver } from "./helpers/fixtures.ts";
import { ApiKeyFixture } from "./secret-fixtures.ts";

/**
 * Hermetic deterministic mock suite: real detection config from policy.json,
 * stub upstream fetch, no network, no live models. Every control carries an
 * allow case and a block/redact/flag counterpart runnable via bare
 * `bun test`. Two policy flags (`entropyScan`, `encodingRescan`) are pinned
 * as config-present but enforcement-unwired gaps: the schema accepts them and
 * policy.json enables them, yet no deterministic stage reads them.
 */

const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_OK = 200;
const NO_CALLS = 0;
const SINGLE_CALL = 1;
const SINGLE_DECISION = 1;

const GROUP_ID = "hr";
const USER_ID = "alice";
const ALLOWED_MODEL = "primary";
const SECOND_MODEL = "local-small";
const UNKNOWN_MODEL = "evil-model";

const WEATHER_TEXT = "What is the weather in Warsaw tomorrow?";
const THANKS_TEXT = "Thanks for the quick reply, much appreciated.";
const REPORT_TEXT = "Thanks for the weekly report, very helpful.";
const CODE_QUESTION_TEXT = "How do I sort a list in Python?";
const BENIGN_BADGE_TEXT = "Badge number 123 please.";
const BENIGN_CODENAME_TEXT = "The launch date is Friday.";
const BENIGN_PASSWORD_TEXT = "my password is hunter";

const EMAIL_TEXT = "Contact me at alice@example.com today.";
const EMAIL_RAW = "alice@example.com";
const EMAIL_PLACEHOLDER = "[EMAIL]";
const EMAIL_BASE64 = "YWxpY2VAZXhhbXBsZS5jb20=";

const CARD_TEXT = "Pay with 4111 1111 1111 1111 now.";
const CARD_RAW = "4111 1111 1111 1111";
const CARD_PLACEHOLDER = "[CARD_LAST4:1111]";
const CARD_BENIGN_TEXT = "Order 4117 was shipped yesterday.";

const BADGE_TEXT = "Badge EMP-482910 please.";
const BADGE_RAW = "EMP-482910";
const BADGE_PLACEHOLDER = "[CUSTOM:EMPLOYEE_ID]";

const CODENAME_TEXT = "The CONFIDENTIAL launch date is Friday.";
const CODENAME_TOKEN = "CONFIDENTIAL";
const COMBINED_TEXT = "Contact alice@example.com about CONFIDENTIAL.";

const GENERIC_ASSIGNMENT_TEXT = "password = supersecretvalue";
const GENERIC_KEY_TEXT = "api_key: hunter2hunter2";
const GENERIC_URL_TEXT = "go https://bob:s3cr3tpass@host/x now";
const HIGH_ENTROPY_TEXT = "token aB3xK9qZ7mQ2vL8nR4tY6wE1uI5oP0aS9dF7 end";

function requirePolicy(document: unknown): Policy {
	const parsed = parsePolicy(document);
	if (!parsed.success) {
		throw new Error("policy document failed validation");
	}
	return parsed.policy;
}

function deterministicPipeline(policy: Policy): ControlPipeline {
	return createControlPipeline({
		controls: [
			createAllowlistControl(policy.controls.allowlist.models),
			createDeterministicControl(policy.controls.detection),
		],
	});
}

function interaction(
	content: string,
	direction: Interaction["direction"],
	seam: Interaction["seam"],
	model?: string,
): Interaction {
	return {
		content,
		direction,
		groupId: GROUP_ID,
		id: `mock-suite-${seam}-${direction}`,
		...(model === undefined ? {} : { model }),
		seam,
		userId: USER_ID,
	};
}

function userHeaders(): Headers {
	return new Headers({
		"content-type": "application/json",
		"x-user-group-id": GROUP_ID,
		"x-user-id": USER_ID,
	});
}

function chatRequest(content: string, model: string): Request {
	return new Request("http://test.local/v1/chat/completions", {
		body: JSON.stringify({ messages: [{ content, role: "user" }], model }),
		headers: userHeaders(),
		method: "POST",
	});
}

function guardApiRequest(content: string, direction: Interaction["direction"]): Request {
	return new Request("http://test.local/api/guard", {
		body: JSON.stringify({ content, direction, seam: "guard-api" }),
		headers: userHeaders(),
		method: "POST",
	});
}

function capturingFetch(): {
	bodies: unknown[];
	calls: () => number;
	fetch: FetchLike;
} {
	const bodies: unknown[] = [];
	let total = 0;
	const fetch = ((_url: string, init?: RequestInit) => {
		total += 1;
		const raw = init?.body;
		bodies.push(raw === undefined ? null : JSON.parse(String(raw)));
		return Promise.resolve(
			new Response(JSON.stringify({ choices: [] }), {
				headers: { "content-type": "application/json" },
				status: HTTP_OK,
			}),
		);
	}) as FetchLike;
	return {
		bodies,
		calls: () => total,
		fetch,
	};
}

function gatewayDeps(
	pipeline: ControlPipeline,
	fetchImpl: FetchLike,
): { audit: ReturnType<typeof auditSink>; deps: GatewayDeps } {
	const audit = auditSink();
	return {
		audit,
		deps: {
			audit,
			fetchImpl,
			identity: identityResolver(),
			ledger: new UsageLedger(),
			pipeline,
			policyBudgetRules: [],
			prices: async () => null,
			upstream: { baseUrl: "https://upstream.invalid" },
		},
	};
}

function decisionsOf(audit: ReturnType<typeof auditSink>): number {
	return audit.events.filter((event) => event.kind === "interaction" && event.verdict !== undefined)
		.length;
}

function secretText(): string {
	return `use this key ${ApiKeyFixture} now`;
}

describe("real detection config from policy.json", () => {
	it("validates and pins the shape limit to MAX_CONTENT_LENGTH", () => {
		const policy = requirePolicy(policyDocument);
		expect(policy.version.length > 0).toBe(true);
		expect(policy.controls.shape.maxContentBytes).toBe(MAX_CONTENT_LENGTH);
	});

	it("enables every deterministic builtin family flag", () => {
		const policy = requirePolicy(policyDocument);
		expect(policy.controls.detection.builtins.encodingRescan).toBe(true);
		expect(policy.controls.detection.builtins.entropyScan).toBe(true);
		expect(policy.controls.detection.builtins.genericCredentials).toBe(true);
		expect(policy.controls.detection.builtins.pii).toBe(true);
		expect(policy.controls.detection.builtins.providerSecrets).toBe(true);
	});

	it("maps secrets to block and pii to redact by default", () => {
		const policy = requirePolicy(policyDocument);
		expect(policy.controls.detection.defaultActions.secret).toBe("block");
		expect(policy.controls.detection.defaultActions.pii).toBe("redact");
	});

	it("ships the employee-id and internal-codename custom rules", () => {
		const policy = requirePolicy(policyDocument);
		const ids = policy.controls.detection.rules.map((rule) => rule.id);
		expect(ids).toContain("employee-id");
		expect(ids).toContain("internal-codename");
		expect(policy.controls.detection.rules.length > 0).toBe(true);
	});
});

describe("pii email allow and redact", () => {
	it("allows benign prose without an address", async () => {
		const policy = requirePolicy(policyDocument);
		const outcome = await guardInteraction(
			interaction(WEATHER_TEXT, "inbound", "chat"),
			deterministicPipeline(policy),
		);
		expect(outcome.verdict).toBe("allow");
		expect(outcome.content).toBe(WEATHER_TEXT);
	});

	it("redacts the address behind [EMAIL] without leaking the raw value", async () => {
		const policy = requirePolicy(policyDocument);
		const outcome = await guardInteraction(
			interaction(EMAIL_TEXT, "inbound", "chat"),
			deterministicPipeline(policy),
		);
		expect(outcome.verdict).toBe("redact");
		expect(outcome.content ?? "").toContain(EMAIL_PLACEHOLDER);
		expect(outcome.content ?? "").not.toContain(EMAIL_RAW);
		expect(outcome.inspection.blockingControl).toBe("deterministic");
	});

	it("forwards email redacted over the gateway with one upstream call", async () => {
		const policy = requirePolicy(policyDocument);
		const capture = capturingFetch();
		const built = gatewayDeps(deterministicPipeline(policy), capture.fetch);
		const response = await handleChatCompletions(
			chatRequest(EMAIL_TEXT, ALLOWED_MODEL),
			built.deps,
		);
		expect(response.status).toBe(HTTP_OK);
		expect(capture.calls()).toBe(SINGLE_CALL);
		expect(decisionsOf(built.audit)).toBe(SINGLE_DECISION);
		expect(JSON.stringify(capture.bodies.at(0) ?? null)).toContain(EMAIL_PLACEHOLDER);
		expect(JSON.stringify(capture.bodies.at(0) ?? null)).not.toContain(EMAIL_RAW);
	});

	it("redacts email through the guard-api seam", async () => {
		const policy = requirePolicy(policyDocument);
		const response = await handleGuardRequest(guardApiRequest(EMAIL_TEXT, "inbound"), {
			identity: identityResolver(),
			pipeline: deterministicPipeline(policy),
		});
		expect(response.status).toBe(HTTP_OK);
		const body = (await response.json()) as { content?: string; verdict?: string };
		expect(body.verdict).toBe("redact");
		expect(body.content ?? "").toContain(EMAIL_PLACEHOLDER);
		expect(body.content ?? "").not.toContain(EMAIL_RAW);
	});
});

describe("payment card allow and redact", () => {
	it("allows short digit runs without card context", async () => {
		const policy = requirePolicy(policyDocument);
		const outcome = await guardInteraction(
			interaction(CARD_BENIGN_TEXT, "inbound", "chat"),
			deterministicPipeline(policy),
		);
		expect(outcome.verdict).toBe("allow");
		expect(outcome.content).toBe(CARD_BENIGN_TEXT);
	});

	it("redacts the pan behind [CARD_LAST4:1111] without leaking raw digits", async () => {
		const policy = requirePolicy(policyDocument);
		const outcome = await guardInteraction(
			interaction(CARD_TEXT, "inbound", "chat"),
			deterministicPipeline(policy),
		);
		expect(outcome.verdict).toBe("redact");
		expect(outcome.content ?? "").toContain(CARD_PLACEHOLDER);
		expect(outcome.content ?? "").not.toContain(CARD_RAW);
	});

	it("forwards the card redacted over the gateway", async () => {
		const policy = requirePolicy(policyDocument);
		const capture = capturingFetch();
		const built = gatewayDeps(deterministicPipeline(policy), capture.fetch);
		const response = await handleChatCompletions(chatRequest(CARD_TEXT, ALLOWED_MODEL), built.deps);
		expect(response.status).toBe(HTTP_OK);
		expect(capture.calls()).toBe(SINGLE_CALL);
		expect(JSON.stringify(capture.bodies.at(0) ?? null)).toContain(CARD_PLACEHOLDER);
		expect(JSON.stringify(capture.bodies.at(0) ?? null)).not.toContain(CARD_RAW);
	});
});

describe("EMP badge custom rule allow and redact", () => {
	it("allows badge prose without the EMP pattern", async () => {
		const policy = requirePolicy(policyDocument);
		const outcome = await guardInteraction(
			interaction(BENIGN_BADGE_TEXT, "inbound", "chat"),
			deterministicPipeline(policy),
		);
		expect(outcome.verdict).toBe("allow");
		expect(outcome.content).toBe(BENIGN_BADGE_TEXT);
	});

	it("redacts the badge inbound behind [CUSTOM:EMPLOYEE_ID]", async () => {
		const policy = requirePolicy(policyDocument);
		const outcome = await guardInteraction(
			interaction(BADGE_TEXT, "inbound", "chat"),
			deterministicPipeline(policy),
		);
		expect(outcome.verdict).toBe("redact");
		expect(outcome.content ?? "").toContain(BADGE_PLACEHOLDER);
		expect(outcome.content ?? "").not.toContain(BADGE_RAW);
	});

	it("redacts the badge outbound as well", async () => {
		const policy = requirePolicy(policyDocument);
		const outcome = await guardInteraction(
			interaction(BADGE_TEXT, "outbound", "chat"),
			deterministicPipeline(policy),
		);
		expect(outcome.verdict).toBe("redact");
		expect(outcome.content ?? "").toContain(BADGE_PLACEHOLDER);
		expect(outcome.content ?? "").not.toContain(BADGE_RAW);
	});
});

describe("CONFIDENTIAL codename direction scoping", () => {
	it("allows the codename inbound unflagged", async () => {
		const policy = requirePolicy(policyDocument);
		const outcome = await guardInteraction(
			interaction(CODENAME_TEXT, "inbound", "chat"),
			deterministicPipeline(policy),
		);
		expect(outcome.verdict).toBe("allow");
		expect(outcome.content).toBe(CODENAME_TEXT);
		expect(outcome.inspection.flagged).toBe(false);
	});

	it("flags the codename outbound while still allowing it", async () => {
		const policy = requirePolicy(policyDocument);
		const outcome = await guardInteraction(
			interaction(CODENAME_TEXT, "outbound", "chat"),
			deterministicPipeline(policy),
		);
		expect(outcome.verdict).toBe("allow");
		expect(outcome.content).toBe(CODENAME_TEXT);
		expect(outcome.inspection.flagged).toBe(true);
	});

	it("forwards the inbound codename verbatim through the gateway", async () => {
		const policy = requirePolicy(policyDocument);
		const capture = capturingFetch();
		const built = gatewayDeps(deterministicPipeline(policy), capture.fetch);
		const response = await handleChatCompletions(
			chatRequest(CODENAME_TEXT, ALLOWED_MODEL),
			built.deps,
		);
		expect(response.status).toBe(HTTP_OK);
		expect(capture.calls()).toBe(SINGLE_CALL);
		expect(JSON.stringify(capture.bodies.at(0) ?? null)).toContain(CODENAME_TOKEN);
	});

	it("redacts combined email plus codename outbound with the flag retained", async () => {
		const policy = requirePolicy(policyDocument);
		const outcome = await guardInteraction(
			interaction(COMBINED_TEXT, "outbound", "chat"),
			deterministicPipeline(policy),
		);
		expect(outcome.verdict).toBe("redact");
		expect(outcome.content ?? "").toContain(EMAIL_PLACEHOLDER);
		expect(outcome.content ?? "").not.toContain(EMAIL_RAW);
		expect(outcome.inspection.flagged).toBe(true);
	});
});

describe("provider secrets block", () => {
	it("allows prose without a secret", async () => {
		const policy = requirePolicy(policyDocument);
		const outcome = await guardInteraction(
			interaction(WEATHER_TEXT, "inbound", "chat"),
			deterministicPipeline(policy),
		);
		expect(outcome.verdict).toBe("allow");
	});

	it("blocks the provider key with deterministic attribution", async () => {
		const policy = requirePolicy(policyDocument);
		const outcome = await guardInteraction(
			interaction(secretText(), "inbound", "chat"),
			deterministicPipeline(policy),
		);
		expect(outcome.verdict).toBe("block");
		expect(outcome.content).toBeUndefined();
		expect(outcome.rejection?.control).toBe("deterministic");
	});

	it("refuses the provider key at the gateway with zero upstream calls", async () => {
		const policy = requirePolicy(policyDocument);
		const capture = capturingFetch();
		const built = gatewayDeps(deterministicPipeline(policy), capture.fetch);
		const response = await handleChatCompletions(
			chatRequest(secretText(), ALLOWED_MODEL),
			built.deps,
		);
		expect(response.status).toBe(HTTP_FORBIDDEN);
		expect(capture.calls()).toBe(NO_CALLS);
		expect(decisionsOf(built.audit)).toBe(SINGLE_DECISION);
	});
});

describe("generic credentials block", () => {
	it("allows password prose without an assignment", async () => {
		const policy = requirePolicy(policyDocument);
		const outcome = await guardInteraction(
			interaction(BENIGN_PASSWORD_TEXT, "inbound", "chat"),
			deterministicPipeline(policy),
		);
		expect(outcome.verdict).toBe("allow");
		expect(outcome.content).toBe(BENIGN_PASSWORD_TEXT);
	});

	it("blocks password assignments", async () => {
		const policy = requirePolicy(policyDocument);
		const outcome = await guardInteraction(
			interaction(GENERIC_ASSIGNMENT_TEXT, "inbound", "chat"),
			deterministicPipeline(policy),
		);
		expect(outcome.verdict).toBe("block");
		expect(outcome.content).toBeUndefined();
	});

	it("blocks api-key assignments", async () => {
		const policy = requirePolicy(policyDocument);
		const outcome = await guardInteraction(
			interaction(GENERIC_KEY_TEXT, "inbound", "chat"),
			deterministicPipeline(policy),
		);
		expect(outcome.verdict).toBe("block");
	});

	it("blocks url-embedded credentials", async () => {
		const policy = requirePolicy(policyDocument);
		const outcome = await guardInteraction(
			interaction(GENERIC_URL_TEXT, "inbound", "chat"),
			deterministicPipeline(policy),
		);
		expect(outcome.verdict).toBe("block");
	});
});

describe("entropyScan flag and high-entropy handling", () => {
	it("declares entropyScan enabled in policy.json", () => {
		const policy = requirePolicy(policyDocument);
		expect(policy.controls.detection.builtins.entropyScan).toBe(true);
	});

	it("allows a bare high-entropy token with no credential shape", async () => {
		const policy = requirePolicy(policyDocument);
		const outcome = await guardInteraction(
			interaction(HIGH_ENTROPY_TEXT, "inbound", "chat"),
			deterministicPipeline(policy),
		);
		expect(outcome.verdict).toBe("allow");
		expect(outcome.content).toBe(HIGH_ENTROPY_TEXT);
	});

	it("blocks a high-entropy provider secret on the secret path", async () => {
		const policy = requirePolicy(policyDocument);
		const outcome = await guardInteraction(
			interaction(secretText(), "inbound", "chat"),
			deterministicPipeline(policy),
		);
		expect(outcome.verdict).toBe("block");
		expect(outcome.rejection?.control).toBe("deterministic");
	});
});

describe("encodingRescan flag and base64 handling", () => {
	it("declares encodingRescan enabled in policy.json", () => {
		const policy = requirePolicy(policyDocument);
		expect(policy.controls.detection.builtins.encodingRescan).toBe(true);
	});

	it("redacts the plain email the encoded payload hides", async () => {
		const policy = requirePolicy(policyDocument);
		const outcome = await guardInteraction(
			interaction(EMAIL_TEXT, "inbound", "chat"),
			deterministicPipeline(policy),
		);
		expect(outcome.verdict).toBe("redact");
		expect(outcome.content ?? "").toContain(EMAIL_PLACEHOLDER);
	});

	it("currently allows the base64-wrapped email through uninspected", async () => {
		const policy = requirePolicy(policyDocument);
		const wrapped = `payload ${EMAIL_BASE64} end`;
		const outcome = await guardInteraction(
			interaction(wrapped, "inbound", "chat"),
			deterministicPipeline(policy),
		);
		expect(outcome.verdict).toBe("allow");
		expect(outcome.content).toBe(wrapped);
	});
});

describe("custom regex rules driven by policy.json", () => {
	it("ships compilable rules with directions for every entry", () => {
		const policy = requirePolicy(policyDocument);
		expect(policy.controls.detection.rules.length > 0).toBe(true);
		for (const rule of policy.controls.detection.rules) {
			expect(rule.id.length > 0).toBe(true);
			expect(rule.pattern.length > 0).toBe(true);
			expect(rule.directions.length > 0).toBe(true);
			expect(() => new RegExp(rule.pattern)).not.toThrow();
		}
	});

	it("redacts employee-id hits in both directions", async () => {
		const policy = requirePolicy(policyDocument);
		const pipeline = deterministicPipeline(policy);
		const inbound = await guardInteraction(interaction(BADGE_TEXT, "inbound", "chat"), pipeline);
		const outbound = await guardInteraction(interaction(BADGE_TEXT, "outbound", "chat"), pipeline);
		expect(inbound.verdict).toBe("redact");
		expect(outbound.verdict).toBe("redact");
	});

	it("scopes internal-codename hits to outbound only", async () => {
		const policy = requirePolicy(policyDocument);
		const pipeline = deterministicPipeline(policy);
		const inbound = await guardInteraction(interaction(CODENAME_TEXT, "inbound", "chat"), pipeline);
		const outbound = await guardInteraction(
			interaction(CODENAME_TEXT, "outbound", "chat"),
			pipeline,
		);
		expect(inbound.verdict).toBe("allow");
		expect(inbound.inspection.flagged).toBe(false);
		expect(outbound.verdict).toBe("allow");
		expect(outbound.inspection.flagged).toBe(true);
	});
});

describe("allowlist models allow and block", () => {
	it("forwards the primary model through the gateway", async () => {
		const policy = requirePolicy(policyDocument);
		const capture = capturingFetch();
		const built = gatewayDeps(deterministicPipeline(policy), capture.fetch);
		const response = await handleChatCompletions(
			chatRequest(WEATHER_TEXT, ALLOWED_MODEL),
			built.deps,
		);
		expect(response.status).toBe(HTTP_OK);
		expect(capture.calls()).toBe(SINGLE_CALL);
	});

	it("forwards the second allowlisted model", async () => {
		const policy = requirePolicy(policyDocument);
		const capture = capturingFetch();
		const built = gatewayDeps(deterministicPipeline(policy), capture.fetch);
		const response = await handleChatCompletions(
			chatRequest(WEATHER_TEXT, SECOND_MODEL),
			built.deps,
		);
		expect(response.status).toBe(HTTP_OK);
		expect(capture.calls()).toBe(SINGLE_CALL);
	});

	it("allows interactions without a model name", async () => {
		const policy = requirePolicy(policyDocument);
		const outcome = await guardInteraction(
			interaction(WEATHER_TEXT, "inbound", "chat"),
			deterministicPipeline(policy),
		);
		expect(outcome.verdict).toBe("allow");
	});

	it("blocks the unknown model with allowlist attribution", async () => {
		const policy = requirePolicy(policyDocument);
		const outcome = await guardInteraction(
			interaction(WEATHER_TEXT, "inbound", "chat", UNKNOWN_MODEL),
			deterministicPipeline(policy),
		);
		expect(outcome.verdict).toBe("block");
		expect(outcome.inspection.blockingControl).toBe("allowlist");
	});

	it("refuses the unknown model at the gateway with zero upstream calls", async () => {
		const policy = requirePolicy(policyDocument);
		const capture = capturingFetch();
		const built = gatewayDeps(deterministicPipeline(policy), capture.fetch);
		const response = await handleChatCompletions(
			chatRequest(WEATHER_TEXT, UNKNOWN_MODEL),
			built.deps,
		);
		expect(response.status).toBe(HTTP_FORBIDDEN);
		expect(capture.calls()).toBe(NO_CALLS);
		expect(decisionsOf(built.audit)).toBe(SINGLE_DECISION);
	});
});

describe("shape maxContentBytes allow and over-limit block", () => {
	it("allows content that fits within the policy byte budget", async () => {
		const policy = requirePolicy(policyDocument);
		const fitting = "x".repeat(policy.controls.shape.maxContentBytes);
		const response = await handleGuardRequest(guardApiRequest(fitting, "inbound"), {
			identity: identityResolver(),
			pipeline: deterministicPipeline(policy),
		});
		expect(response.status).toBe(HTTP_OK);
	});

	it("rejects content over the policy byte budget before controls run", async () => {
		const policy = requirePolicy(policyDocument);
		let inspections = 0;
		const source = deterministicPipeline(policy);
		const counting: ControlPipeline = {
			inspect: (examined) => {
				inspections += 1;
				return source.inspect(examined);
			},
		};
		const oversized = "x".repeat(policy.controls.shape.maxContentBytes + 1);
		const response = await handleGuardRequest(guardApiRequest(oversized, "inbound"), {
			identity: identityResolver(),
			pipeline: counting,
		});
		expect(response.status).toBe(HTTP_BAD_REQUEST);
		expect(inspections).toBe(NO_CALLS);
	});
});

describe("redaction placeholders never leak raw values", () => {
	it("parses with redaction enabled", () => {
		const policy = requirePolicy(policyDocument);
		expect(policy.controls.redaction.enabled).toBe(true);
	});

	it("replaces email with [EMAIL]", async () => {
		const policy = requirePolicy(policyDocument);
		const outcome = await guardInteraction(
			interaction(EMAIL_TEXT, "inbound", "chat"),
			deterministicPipeline(policy),
		);
		expect(outcome.verdict).toBe("redact");
		expect(outcome.content ?? "").toContain(EMAIL_PLACEHOLDER);
		expect(outcome.content ?? "").not.toContain(EMAIL_RAW);
	});

	it("replaces cards with [CARD_LAST4:1111]", async () => {
		const policy = requirePolicy(policyDocument);
		const outcome = await guardInteraction(
			interaction(CARD_TEXT, "inbound", "chat"),
			deterministicPipeline(policy),
		);
		expect(outcome.content ?? "").toContain(CARD_PLACEHOLDER);
		expect(outcome.content ?? "").not.toContain(CARD_RAW);
	});

	it("replaces badges with [CUSTOM:EMPLOYEE_ID]", async () => {
		const policy = requirePolicy(policyDocument);
		const outcome = await guardInteraction(
			interaction(BADGE_TEXT, "inbound", "chat"),
			deterministicPipeline(policy),
		);
		expect(outcome.content ?? "").toContain(BADGE_PLACEHOLDER);
		expect(outcome.content ?? "").not.toContain(BADGE_RAW);
	});

	it("still redacts when redaction is toggled off because the flag is display-only", async () => {
		const cloned = structuredClone(policyDocument) as unknown as Policy;
		cloned.controls.redaction.enabled = false;
		const policy = requirePolicy(cloned);
		expect(policy.controls.redaction.enabled).toBe(false);
		const outcome = await guardInteraction(
			interaction(EMAIL_TEXT, "inbound", "chat"),
			deterministicPipeline(policy),
		);
		expect(outcome.verdict).toBe("redact");
		expect(outcome.content ?? "").toContain(EMAIL_PLACEHOLDER);
		expect(outcome.content ?? "").not.toContain(EMAIL_RAW);
	});
});

describe("inbound versus outbound direction scoping", () => {
	it("treats email identically in both directions", async () => {
		const policy = requirePolicy(policyDocument);
		const pipeline = deterministicPipeline(policy);
		const inbound = await guardInteraction(interaction(EMAIL_TEXT, "inbound", "chat"), pipeline);
		const outbound = await guardInteraction(interaction(EMAIL_TEXT, "outbound", "chat"), pipeline);
		expect(inbound.verdict).toBe("redact");
		expect(outbound.verdict).toBe("redact");
	});

	it("treats the codename differently by direction", async () => {
		const policy = requirePolicy(policyDocument);
		const pipeline = deterministicPipeline(policy);
		const inbound = await guardInteraction(interaction(CODENAME_TEXT, "inbound", "chat"), pipeline);
		const outbound = await guardInteraction(
			interaction(CODENAME_TEXT, "outbound", "chat"),
			pipeline,
		);
		expect(inbound.inspection.flagged).toBe(false);
		expect(outbound.inspection.flagged).toBe(true);
	});

	it("allows launch prose without the token outbound", async () => {
		const policy = requirePolicy(policyDocument);
		const outcome = await guardInteraction(
			interaction(BENIGN_CODENAME_TEXT, "outbound", "chat"),
			deterministicPipeline(policy),
		);
		expect(outcome.verdict).toBe("allow");
		expect(outcome.inspection.flagged).toBe(false);
	});

	it("treats badge hits identically in both directions", async () => {
		const policy = requirePolicy(policyDocument);
		const pipeline = deterministicPipeline(policy);
		const inbound = await guardInteraction(interaction(BADGE_TEXT, "inbound", "chat"), pipeline);
		const outbound = await guardInteraction(interaction(BADGE_TEXT, "outbound", "chat"), pipeline);
		expect(inbound.verdict).toBe("redact");
		expect(outbound.verdict).toBe("redact");
	});
});

describe("chat, guard-api, and mcp-tool seams", () => {
	it("redacts email on the chat seam", async () => {
		const policy = requirePolicy(policyDocument);
		const outcome = await guardInteraction(
			interaction(EMAIL_TEXT, "inbound", "chat"),
			deterministicPipeline(policy),
		);
		expect(outcome.verdict).toBe("redact");
		expect(outcome.content ?? "").toContain(EMAIL_PLACEHOLDER);
	});

	it("redacts email on the guard-api seam", async () => {
		const policy = requirePolicy(policyDocument);
		const outcome = await guardInteraction(
			interaction(EMAIL_TEXT, "inbound", "guard-api"),
			deterministicPipeline(policy),
		);
		expect(outcome.verdict).toBe("redact");
		expect(outcome.content ?? "").toContain(EMAIL_PLACEHOLDER);
	});

	it("redacts email on the mcp-tool seam", async () => {
		const policy = requirePolicy(policyDocument);
		const outcome = await guardInteraction(
			interaction(EMAIL_TEXT, "inbound", "mcp-tool"),
			deterministicPipeline(policy),
		);
		expect(outcome.verdict).toBe("redact");
		expect(outcome.content ?? "").toContain(EMAIL_PLACEHOLDER);
	});

	it("blocks secrets on the mcp-tool seam", async () => {
		const policy = requirePolicy(policyDocument);
		const outcome = await guardInteraction(
			interaction(secretText(), "inbound", "mcp-tool"),
			deterministicPipeline(policy),
		);
		expect(outcome.verdict).toBe("block");
		expect(outcome.rejection?.control).toBe("deterministic");
	});

	it("flags the outbound codename on the mcp-tool seam", async () => {
		const policy = requirePolicy(policyDocument);
		const outcome = await guardInteraction(
			interaction(CODENAME_TEXT, "outbound", "mcp-tool"),
			deterministicPipeline(policy),
		);
		expect(outcome.verdict).toBe("allow");
		expect(outcome.inspection.flagged).toBe(true);
	});
});

describe("benign traffic allows", () => {
	it("allows the weather question", async () => {
		const policy = requirePolicy(policyDocument);
		const outcome = await guardInteraction(
			interaction(WEATHER_TEXT, "inbound", "chat"),
			deterministicPipeline(policy),
		);
		expect(outcome.verdict).toBe("allow");
		expect(outcome.content).toBe(WEATHER_TEXT);
	});

	it("allows the thanks note", async () => {
		const policy = requirePolicy(policyDocument);
		const outcome = await guardInteraction(
			interaction(THANKS_TEXT, "inbound", "chat"),
			deterministicPipeline(policy),
		);
		expect(outcome.verdict).toBe("allow");
		expect(outcome.content).toBe(THANKS_TEXT);
	});

	it("allows the report note", async () => {
		const policy = requirePolicy(policyDocument);
		const outcome = await guardInteraction(
			interaction(REPORT_TEXT, "inbound", "chat"),
			deterministicPipeline(policy),
		);
		expect(outcome.verdict).toBe("allow");
		expect(outcome.content).toBe(REPORT_TEXT);
	});

	it("allows the code question", async () => {
		const policy = requirePolicy(policyDocument);
		const outcome = await guardInteraction(
			interaction(CODE_QUESTION_TEXT, "inbound", "chat"),
			deterministicPipeline(policy),
		);
		expect(outcome.verdict).toBe("allow");
		expect(outcome.content).toBe(CODE_QUESTION_TEXT);
	});

	it("forwards benign content through the gateway with one audit decision", async () => {
		const policy = requirePolicy(policyDocument);
		const capture = capturingFetch();
		const built = gatewayDeps(deterministicPipeline(policy), capture.fetch);
		const response = await handleChatCompletions(
			chatRequest(WEATHER_TEXT, ALLOWED_MODEL),
			built.deps,
		);
		expect(response.status).toBe(HTTP_OK);
		expect(capture.calls()).toBe(SINGLE_CALL);
		expect(decisionsOf(built.audit)).toBe(SINGLE_DECISION);
		expect(JSON.stringify(capture.bodies.at(0) ?? null)).toContain(WEATHER_TEXT);
	});
});
