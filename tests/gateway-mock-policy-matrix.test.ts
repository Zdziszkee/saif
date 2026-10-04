import { describe, expect, it } from "bun:test";
import { createAllowlistControl } from "#/control/allowlist.ts";
import { createDeterministicControl } from "#/control/deterministic/control.ts";
import { guardInteraction } from "#/control/guard.ts";
import { handleGuardRequest } from "#/control/guard-api.ts";
import { createControlPipeline } from "#/control/pipeline.ts";
import { type ProfileName, resolveProfile } from "#/control/policy/apply.ts";
import { type Policy, parsePolicy } from "#/control/policy/schema.ts";
import { createSemanticControl } from "#/control/semantic/control.ts";
import { createFixedClassifier } from "#/control/semantic/double.ts";
import { SEMANTIC_DEFAULTS } from "#/control/semantic/index.ts";
import { MAX_CONTENT_LENGTH } from "#/control/shape.ts";
import { createSignatureControl } from "#/control/signatures/control.ts";
import { loadSignatureFeed } from "#/control/signatures/feed.ts";
import type { ControlPipeline, Interaction } from "#/control/types.ts";
import { type GatewayDeps, handleChatCompletions } from "#/gateway/gateway.ts";
import type { FetchLike } from "#/gateway/openai.ts";
import { type BudgetRule, UsageLedger } from "#/gateway/usage.ts";
import policyDocument from "../policy.json" with { type: "json" };
import permissiveDocument from "../policy.permissive.json" with { type: "json" };
import strictDocument from "../policy.strict.json" with { type: "json" };
import feedDocument from "../signatures.json" with { type: "json" };
import { auditSink, identityResolver } from "./helpers/fixtures.ts";
import { ApiKeyFixture } from "./secret-fixtures.ts";

/**
 * Hermetic mock policy matrix: no SEMANTIC_LIVE, no network, no TYPESAFE_API_KEY.
 * Real deterministic + signature + fixed-answer semantic tiers behind the
 * shared pipeline; upstream is always a stub fetch. Policy.json drives the
 * matrix (its deterministic verdicts are profile-stable); the permissive and
 * strict documents are validated and their deliberate divergences spot-checked.
 */

const HTTP_FORBIDDEN = 403;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const SINGLE_DECISION = 1;
const SINGLE_CALL = 1;
const NO_CALLS = 0;
const BENIGN_TEXT = "What is the weather in Warsaw tomorrow?";
const EMAIL_TEXT = "Contact me at alice@example.com";
const EMAIL_PLACEHOLDER = "[EMAIL]";
const EMAIL_RAW = "alice@example.com";
const BADGE_TEXT = "Badge EMP-482910 please.";
const BADGE_PLACEHOLDER = "[CUSTOM:EMPLOYEE_ID]";
const CARD_TEXT = "Pay with 4111 1111 1111 1111 now";
const CARD_PLACEHOLDER = "[CARD_LAST4:1111]";
const CODENAME_TEXT = "The CONFIDENTIAL launch date is Friday.";
const CODENAME_TOKEN = "CONFIDENTIAL";
const ALLOWED_MODEL = "primary";
const SECOND_MODEL = "local-small";
const UNKNOWN_MODEL = "evil-model";
const GROUP_ID = "hr";
const USER_ID = "alice";
const OTHER_USER = "mallory";
const OTHER_MODEL = "other-model";
const BUDGET_TOKENS = 10;
const BUDGET_REQUESTS = 2;
const BUDGET_COST = 5;
const SPENT_TOKENS = 10;
const UNDER_TOKENS = 4;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DOUBLE_HOURS_MS = 2 * HOUR_MS;
const DOUBLE_DAYS_MS = 2 * DAY_MS;
const FORTY_DAYS_MS = 40 * DAY_MS;
const LARGE_PROMPT = 99;
const SMALL_PROMPT = 1;

const PROFILES: readonly ProfileName[] = ["permissive", "standard", "strict"];
const SEAMS: readonly Interaction["seam"][] = ["chat", "guard-api", "mcp-tool"];
const DIRECTIONS: readonly Interaction["direction"][] = ["inbound", "outbound"];

function requirePolicy(document: unknown, label: string): Policy {
	const parsed = parsePolicy(document);
	if (!parsed.success) {
		throw new Error(`${label} failed validation`);
	}
	return parsed.policy;
}

function matrixPipeline(policy: Policy, profile: ProfileName): ControlPipeline {
	const classifier = createFixedClassifier(
		{ probabilities: {} },
		{ checks: SEMANTIC_DEFAULTS.checks },
	);
	const loaded = loadSignatureFeed(feedDocument);
	return createControlPipeline({
		controls: [
			createAllowlistControl(policy.controls.allowlist.models),
			createSignatureControl({
				config: policy.controls.signatures,
				getFeed: () => ({ entries: loaded.entries, version: loaded.version }),
			}),
			createDeterministicControl(policy.controls.detection),
			createSemanticControl({ checks: [...SEMANTIC_DEFAULTS.checks], classifier }),
		],
		profile: resolveProfile(policy, profile),
	});
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

function guardRequest(
	content: string,
	seam: Interaction["seam"],
	direction: Interaction["direction"],
): Request {
	return new Request("http://test.local/api/guard", {
		body: JSON.stringify({ content, direction, seam }),
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
	ledger?: UsageLedger,
	rules?: readonly BudgetRule[],
): { audit: ReturnType<typeof auditSink>; deps: GatewayDeps } {
	const audit = auditSink();
	const targetLedger = ledger ?? new UsageLedger();
	const targetRules = rules ?? [];
	return {
		audit,
		deps: {
			audit,
			fetchImpl,
			identity: identityResolver(),
			ledger: targetLedger,
			pipeline,
			policyBudgetRules: targetRules,
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

function recordSpend(
	ledger: UsageLedger,
	options: {
		at: string;
		cost: number | null;
		model: string;
		prompt: number;
		user: string;
	},
): void {
	ledger.record({
		at: options.at,
		completionTokens: 0,
		costUsd: options.cost,
		groupId: GROUP_ID,
		model: options.model,
		promptTokens: options.prompt,
		userId: options.user,
	});
}

describe("policy documents validate", () => {
	it("policy.json validates", () => {
		const policy = requirePolicy(policyDocument, "policy.json");
		expect(policy.version.length > 0).toBe(true);
		expect(policy.controls.shape.maxContentBytes).toBe(MAX_CONTENT_LENGTH);
		expect(policy.controls.allowlist.models.length > 0).toBe(true);
	});

	it("policy.permissive.json validates", () => {
		const policy = requirePolicy(permissiveDocument, "policy.permissive.json");
		expect(policy.version.length > 0).toBe(true);
		expect(policy.controls.shape.maxContentBytes).toBe(MAX_CONTENT_LENGTH);
		expect(policy.controls.allowlist.models.length > 0).toBe(true);
	});

	it("policy.strict.json validates", () => {
		const policy = requirePolicy(strictDocument, "policy.strict.json");
		expect(policy.version.length > 0).toBe(true);
		expect(policy.controls.allowlist.models.length > 0).toBe(true);
	});

	it("permissive redacts secrets while the main policy blocks them", async () => {
		const main = requirePolicy(policyDocument, "policy.json");
		const permissive = requirePolicy(permissiveDocument, "policy.permissive.json");
		const text = secretText();
		const mainOutcome = await guardInteraction(
			{ content: text, direction: "inbound", groupId: GROUP_ID, id: "matrix-main", seam: "chat" },
			matrixPipeline(main, "standard"),
		);
		const permissiveOutcome = await guardInteraction(
			{
				content: text,
				direction: "inbound",
				groupId: GROUP_ID,
				id: "matrix-permissive",
				seam: "chat",
			},
			matrixPipeline(permissive, "standard"),
		);
		expect(mainOutcome.verdict).toBe("block");
		expect(permissiveOutcome.verdict).toBe("redact");
	});

	it("strict blocks the codename while the main policy only flags it outbound", async () => {
		const main = requirePolicy(policyDocument, "policy.json");
		const strict = requirePolicy(strictDocument, "policy.strict.json");
		const mainOutcome = await guardInteraction(
			{
				content: CODENAME_TEXT,
				direction: "outbound",
				groupId: GROUP_ID,
				id: "matrix-main-codename",
				seam: "chat",
			},
			matrixPipeline(main, "standard"),
		);
		const strictOutcome = await guardInteraction(
			{
				content: CODENAME_TEXT,
				direction: "inbound",
				groupId: GROUP_ID,
				id: "matrix-strict-codename",
				seam: "chat",
			},
			matrixPipeline(strict, "standard"),
		);
		expect(mainOutcome.verdict).toBe("allow");
		expect(mainOutcome.inspection.flagged).toBe(true);
		expect(strictOutcome.verdict).toBe("block");
	});
});

describe("payload matrix across profiles, seams, and directions", () => {
	const policy = requirePolicy(policyDocument, "policy.json");
	for (const profile of PROFILES) {
		for (const seam of SEAMS) {
			for (const direction of DIRECTIONS) {
				it(`benign allows / ${profile} / ${seam} / ${direction}`, async () => {
					const outcome = await guardInteraction(
						{
							content: BENIGN_TEXT,
							direction,
							groupId: GROUP_ID,
							id: `matrix-benign-${profile}-${seam}-${direction}`,
							seam,
						},
						matrixPipeline(policy, profile),
					);
					expect(outcome.verdict).toBe("allow");
					expect(outcome.content).toBe(BENIGN_TEXT);
				});

				it(`email redacts with typed placeholder / ${profile} / ${seam} / ${direction}`, async () => {
					const outcome = await guardInteraction(
						{
							content: EMAIL_TEXT,
							direction,
							groupId: GROUP_ID,
							id: `matrix-email-${profile}-${seam}-${direction}`,
							seam,
						},
						matrixPipeline(policy, profile),
					);
					expect(outcome.verdict).toBe("redact");
					expect(outcome.content ?? "").toContain(EMAIL_PLACEHOLDER);
					expect(outcome.content ?? "").not.toContain(EMAIL_RAW);
					expect(outcome.inspection.blockingControl).toBe("deterministic");
				});

				it(`secret blocks / ${profile} / ${seam} / ${direction}`, async () => {
					const outcome = await guardInteraction(
						{
							content: secretText(),
							direction,
							groupId: GROUP_ID,
							id: `matrix-secret-${profile}-${seam}-${direction}`,
							seam,
						},
						matrixPipeline(policy, profile),
					);
					expect(outcome.verdict).toBe("block");
					expect(outcome.content).toBeUndefined();
					expect(outcome.rejection?.control).toBe("deterministic");
				});

				it(`badge redacts / ${profile} / ${seam} / ${direction}`, async () => {
					const outcome = await guardInteraction(
						{
							content: BADGE_TEXT,
							direction,
							groupId: GROUP_ID,
							id: `matrix-badge-${profile}-${seam}-${direction}`,
							seam,
						},
						matrixPipeline(policy, profile),
					);
					expect(outcome.verdict).toBe("redact");
					expect(outcome.content ?? "").toContain(BADGE_PLACEHOLDER);
				});

				it(`payment card redacts / ${profile} / ${seam} / ${direction}`, async () => {
					const outcome = await guardInteraction(
						{
							content: CARD_TEXT,
							direction,
							groupId: GROUP_ID,
							id: `matrix-card-${profile}-${seam}-${direction}`,
							seam,
						},
						matrixPipeline(policy, profile),
					);
					expect(outcome.verdict).toBe("redact");
					expect(outcome.content ?? "").toContain(CARD_PLACEHOLDER);
				});
			}
		}
	}

	for (const profile of PROFILES) {
		for (const seam of SEAMS) {
			it(`codename inbound allows unflagged / ${profile} / ${seam}`, async () => {
				const outcome = await guardInteraction(
					{
						content: CODENAME_TEXT,
						direction: "inbound",
						groupId: GROUP_ID,
						id: `matrix-codename-in-${profile}-${seam}`,
						seam,
					},
					matrixPipeline(policy, profile),
				);
				expect(outcome.verdict).toBe("allow");
				expect(outcome.content).toBe(CODENAME_TEXT);
				expect(outcome.inspection.flagged).toBe(false);
			});

			it(`codename outbound flags without refusing / ${profile} / ${seam}`, async () => {
				const outcome = await guardInteraction(
					{
						content: CODENAME_TEXT,
						direction: "outbound",
						groupId: GROUP_ID,
						id: `matrix-codename-out-${profile}-${seam}`,
						seam,
					},
					matrixPipeline(policy, profile),
				);
				expect(outcome.verdict).toBe("allow");
				expect(outcome.content).toBe(CODENAME_TEXT);
				expect(outcome.inspection.flagged).toBe(true);
			});
		}
	}
});

describe("guard-api seam over the same pipeline", () => {
	const policy = requirePolicy(policyDocument, "policy.json");
	it("allows benign guard content", async () => {
		const response = await handleGuardRequest(guardRequest(BENIGN_TEXT, "guard-api", "inbound"), {
			identity: identityResolver(),
			pipeline: matrixPipeline(policy, "standard"),
		});
		expect(response.status).toBe(HTTP_OK);
	});

	it("redacts email guard content with the typed placeholder", async () => {
		const response = await handleGuardRequest(guardRequest(EMAIL_TEXT, "guard-api", "inbound"), {
			identity: identityResolver(),
			pipeline: matrixPipeline(policy, "standard"),
		});
		expect(response.status).toBe(HTTP_OK);
		const body = (await response.json()) as { content?: string; verdict?: string };
		expect(body.verdict).toBe("redact");
		expect(body.content ?? "").toContain(EMAIL_PLACEHOLDER);
	});

	it("blocks secret guard content", async () => {
		const response = await handleGuardRequest(guardRequest(secretText(), "guard-api", "inbound"), {
			identity: identityResolver(),
			pipeline: matrixPipeline(policy, "standard"),
		});
		expect(response.status).toBe(HTTP_FORBIDDEN);
	});

	it("flags codename outbound while allowing it", async () => {
		const response = await handleGuardRequest(
			guardRequest(CODENAME_TEXT, "guard-api", "outbound"),
			{
				identity: identityResolver(),
				pipeline: matrixPipeline(policy, "standard"),
			},
		);
		expect(response.status).toBe(HTTP_OK);
		const body = (await response.json()) as { flagged?: boolean; verdict?: string };
		expect(body.verdict).toBe("allow");
		expect(body.flagged).toBe(true);
	});

	it("redacts payment card guard content", async () => {
		const response = await handleGuardRequest(guardRequest(CARD_TEXT, "guard-api", "inbound"), {
			identity: identityResolver(),
			pipeline: matrixPipeline(policy, "standard"),
		});
		expect(response.status).toBe(HTTP_OK);
		const body = (await response.json()) as { content?: string; verdict?: string };
		expect(body.verdict).toBe("redact");
		expect(body.content ?? "").toContain(CARD_PLACEHOLDER);
	});
});

describe("gateway forwards and refusals carry exactly one audit decision", () => {
	const policy = requirePolicy(policyDocument, "policy.json");

	async function gatewayCase(content: string): Promise<{
		auditDecisions: number;
		calls: number;
		forwarded: string;
		status: number;
	}> {
		const capture = capturingFetch();
		const built = gatewayDeps(matrixPipeline(policy, "standard"), capture.fetch);
		const response = await handleChatCompletions(chatRequest(content, ALLOWED_MODEL), built.deps);
		const forwardedValue = capture.bodies.at(0) as unknown;
		const forwardedText = JSON.stringify(forwardedValue ?? null);
		return {
			auditDecisions: decisionsOf(built.audit),
			calls: capture.calls(),
			forwarded: forwardedText,
			status: response.status,
		};
	}

	it("forwards benign content with one upstream call and one decision", async () => {
		const result = await gatewayCase(BENIGN_TEXT);
		expect(result.status).toBe(HTTP_OK);
		expect(result.calls).toBe(SINGLE_CALL);
		expect(result.auditDecisions).toBe(SINGLE_DECISION);
		expect(result.forwarded).toContain(BENIGN_TEXT);
	});

	it("forwards email redacted to the typed placeholder", async () => {
		const result = await gatewayCase(EMAIL_TEXT);
		expect(result.status).toBe(HTTP_OK);
		expect(result.calls).toBe(SINGLE_CALL);
		expect(result.auditDecisions).toBe(SINGLE_DECISION);
		expect(result.forwarded).toContain(EMAIL_PLACEHOLDER);
		expect(result.forwarded).not.toContain(EMAIL_RAW);
	});

	it("refuses secrets with zero upstream calls and one decision", async () => {
		const result = await gatewayCase(secretText());
		expect(result.status).toBe(HTTP_FORBIDDEN);
		expect(result.calls).toBe(NO_CALLS);
		expect(result.auditDecisions).toBe(SINGLE_DECISION);
	});

	it("forwards badge redacted", async () => {
		const result = await gatewayCase(BADGE_TEXT);
		expect(result.status).toBe(HTTP_OK);
		expect(result.calls).toBe(SINGLE_CALL);
		expect(result.auditDecisions).toBe(SINGLE_DECISION);
		expect(result.forwarded).toContain(BADGE_PLACEHOLDER);
	});

	it("forwards payment card redacted", async () => {
		const result = await gatewayCase(CARD_TEXT);
		expect(result.status).toBe(HTTP_OK);
		expect(result.calls).toBe(SINGLE_CALL);
		expect(result.auditDecisions).toBe(SINGLE_DECISION);
		expect(result.forwarded).toContain(CARD_PLACEHOLDER);
	});

	it("forwards inbound codename verbatim because the rule is outbound-only", async () => {
		const result = await gatewayCase(CODENAME_TEXT);
		expect(result.status).toBe(HTTP_OK);
		expect(result.calls).toBe(SINGLE_CALL);
		expect(result.auditDecisions).toBe(SINGLE_DECISION);
		expect(result.forwarded).toContain(CODENAME_TOKEN);
	});
});

describe("allowlist enforcement", () => {
	const policy = requirePolicy(policyDocument, "policy.json");

	it("blocks unknown models with the allowlist verdict", async () => {
		const outcome = await guardInteraction(
			{
				content: BENIGN_TEXT,
				direction: "inbound",
				groupId: GROUP_ID,
				id: "matrix-allowlist-unknown",
				model: UNKNOWN_MODEL,
				seam: "chat",
			},
			matrixPipeline(policy, "standard"),
		);
		expect(outcome.verdict).toBe("block");
		expect(outcome.inspection.blockingControl).toBe("allowlist");
	});

	it("forwards allowed models through the gateway", async () => {
		const capture = capturingFetch();
		const built = gatewayDeps(matrixPipeline(policy, "standard"), capture.fetch);
		const response = await handleChatCompletions(
			chatRequest(BENIGN_TEXT, ALLOWED_MODEL),
			built.deps,
		);
		expect(response.status).toBe(HTTP_OK);
		expect(capture.calls()).toBe(SINGLE_CALL);
		expect(decisionsOf(built.audit)).toBe(SINGLE_DECISION);
	});

	it("forwards the second allowlisted model", async () => {
		const capture = capturingFetch();
		const built = gatewayDeps(matrixPipeline(policy, "standard"), capture.fetch);
		const response = await handleChatCompletions(
			chatRequest(BENIGN_TEXT, SECOND_MODEL),
			built.deps,
		);
		expect(response.status).toBe(HTTP_OK);
		expect(capture.calls()).toBe(SINGLE_CALL);
	});

	it("blocks unknown models at the gateway with zero upstream calls", async () => {
		const capture = capturingFetch();
		const built = gatewayDeps(matrixPipeline(policy, "standard"), capture.fetch);
		const response = await handleChatCompletions(
			chatRequest(BENIGN_TEXT, UNKNOWN_MODEL),
			built.deps,
		);
		expect(response.status).toBe(HTTP_FORBIDDEN);
		expect(capture.calls()).toBe(NO_CALLS);
		expect(decisionsOf(built.audit)).toBe(SINGLE_DECISION);
	});
});

describe("shape limits", () => {
	it("documents per-document maxContentBytes", () => {
		const main = requirePolicy(policyDocument, "policy.json");
		const permissive = requirePolicy(permissiveDocument, "policy.permissive.json");
		const strict = requirePolicy(strictDocument, "policy.strict.json");
		expect(main.controls.shape.maxContentBytes).toBe(MAX_CONTENT_LENGTH);
		expect(permissive.controls.shape.maxContentBytes).toBe(MAX_CONTENT_LENGTH);
		expect(strict.controls.shape.maxContentBytes < MAX_CONTENT_LENGTH).toBe(true);
	});

	it("rejects envelope content over MAX_CONTENT_LENGTH before controls run", async () => {
		const policy = requirePolicy(policyDocument, "policy.json");
		let inspections = 0;
		const counting: ControlPipeline = {
			inspect: (interaction) => {
				inspections += 1;
				return matrixPipeline(policy, "standard").inspect(interaction);
			},
		};
		const oversized = "x".repeat(MAX_CONTENT_LENGTH + 1);
		const response = await handleGuardRequest(guardRequest(oversized, "guard-api", "inbound"), {
			identity: identityResolver(),
			pipeline: counting,
		});
		expect(response.status).toBe(HTTP_BAD_REQUEST);
		expect(inspections).toBe(NO_CALLS);
	});

	it("treats content over the policy maxContentBytes as oversized", () => {
		const strict = requirePolicy(strictDocument, "policy.strict.json");
		const limit = strict.controls.shape.maxContentBytes;
		const oversized = "x".repeat(limit + 1);
		const bytes = new TextEncoder().encode(oversized).length;
		expect(bytes > limit).toBe(true);
		const fitting = "x".repeat(limit);
		const fittingBytes = new TextEncoder().encode(fitting).length;
		expect(fittingBytes <= limit).toBe(true);
	});
});

describe("redaction toggle", () => {
	it("parses with redaction enabled and redacts email", async () => {
		const policy = requirePolicy(policyDocument, "policy.json");
		expect(policy.controls.redaction.enabled).toBe(true);
		const outcome = await guardInteraction(
			{
				content: EMAIL_TEXT,
				direction: "inbound",
				groupId: GROUP_ID,
				id: "matrix-redact-on",
				seam: "chat",
			},
			matrixPipeline(policy, "standard"),
		);
		expect(outcome.verdict).toBe("redact");
		expect(outcome.content ?? "").toContain(EMAIL_PLACEHOLDER);
	});

	it("parses with redaction disabled; the deterministic tier still redacts", async () => {
		const cloned = structuredClone(policyDocument) as unknown as Policy;
		cloned.controls.redaction.enabled = false;
		const parsed = parsePolicy(cloned);
		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			throw new Error("disabled-redaction policy failed validation");
		}
		const outcome = await guardInteraction(
			{
				content: EMAIL_TEXT,
				direction: "inbound",
				groupId: GROUP_ID,
				id: "matrix-redact-off",
				seam: "chat",
			},
			matrixPipeline(parsed.policy, "standard"),
		);
		expect(outcome.verdict).toBe("redact");
		expect(outcome.content ?? "").toContain(EMAIL_PLACEHOLDER);
	});
});

describe("budgets across dimensions and windows", () => {
	const policy = requirePolicy(policyDocument, "policy.json");

	async function budgetedStatus(
		rule: BudgetRule,
		ledger: UsageLedger,
		model: string,
		user: string,
	): Promise<{ calls: number; decisions: number; status: number }> {
		const capture = capturingFetch();
		const built = gatewayDeps(matrixPipeline(policy, "standard"), capture.fetch, ledger, [rule]);
		const request = new Request("http://test.local/v1/chat/completions", {
			body: JSON.stringify({ messages: [{ content: BENIGN_TEXT, role: "user" }], model }),
			headers: new Headers({
				"content-type": "application/json",
				"x-user-group-id": GROUP_ID,
				"x-user-id": user,
			}),
			method: "POST",
		});
		const response = await handleChatCompletions(request, built.deps);
		return { calls: capture.calls(), decisions: decisionsOf(built.audit), status: response.status };
	}

	function ledgerWithTokenSpend(tokens: number, at: string): UsageLedger {
		const ledger = new UsageLedger();
		recordSpend(ledger, { at, cost: null, model: ALLOWED_MODEL, prompt: tokens, user: USER_ID });
		return ledger;
	}

	for (const period of ["day", "hour", "month"] as const) {
		it(`blocks over-budget tokens for ${period} with zero upstream calls`, async () => {
			const ledger = ledgerWithTokenSpend(SPENT_TOKENS, new Date().toISOString());
			const result = await budgetedStatus(
				{ key: USER_ID, modelScope: "*", period, tokens: BUDGET_TOKENS },
				ledger,
				ALLOWED_MODEL,
				USER_ID,
			);
			expect(result.status).toBe(HTTP_FORBIDDEN);
			expect(result.calls).toBe(NO_CALLS);
			expect(result.decisions).toBe(SINGLE_DECISION);
		});

		it(`allows under-limit tokens for ${period}`, async () => {
			const ledger = ledgerWithTokenSpend(UNDER_TOKENS, new Date().toISOString());
			const result = await budgetedStatus(
				{ key: USER_ID, modelScope: "*", period, tokens: BUDGET_TOKENS },
				ledger,
				ALLOWED_MODEL,
				USER_ID,
			);
			expect(result.status).toBe(HTTP_OK);
			expect(result.calls).toBe(SINGLE_CALL);
		});

		it(`blocks over-budget requests for ${period}`, async () => {
			const ledger = new UsageLedger();
			const nowIso = new Date().toISOString();
			recordSpend(ledger, {
				at: nowIso,
				cost: null,
				model: ALLOWED_MODEL,
				prompt: SMALL_PROMPT,
				user: USER_ID,
			});
			recordSpend(ledger, {
				at: nowIso,
				cost: null,
				model: ALLOWED_MODEL,
				prompt: SMALL_PROMPT,
				user: USER_ID,
			});
			const result = await budgetedStatus(
				{ key: USER_ID, modelScope: "*", period, requests: BUDGET_REQUESTS },
				ledger,
				ALLOWED_MODEL,
				USER_ID,
			);
			expect(result.status).toBe(HTTP_FORBIDDEN);
			expect(result.calls).toBe(NO_CALLS);
		});

		it(`blocks over-budget cost for ${period}`, async () => {
			const ledger = new UsageLedger();
			recordSpend(ledger, {
				at: new Date().toISOString(),
				cost: BUDGET_COST,
				model: ALLOWED_MODEL,
				prompt: SMALL_PROMPT,
				user: USER_ID,
			});
			const result = await budgetedStatus(
				{ costUsd: BUDGET_COST, key: USER_ID, modelScope: "*", period },
				ledger,
				ALLOWED_MODEL,
				USER_ID,
			);
			expect(result.status).toBe(HTTP_FORBIDDEN);
			expect(result.calls).toBe(NO_CALLS);
		});

		it(`computeTimeMs rules never block for ${period} because usage has no compute signal`, async () => {
			const ledger = ledgerWithTokenSpend(LARGE_PROMPT, new Date().toISOString());
			const result = await budgetedStatus(
				{ computeTimeMs: SMALL_PROMPT, key: USER_ID, modelScope: "*", period },
				ledger,
				ALLOWED_MODEL,
				USER_ID,
			);
			expect(result.status).toBe(HTTP_OK);
			expect(result.calls).toBe(SINGLE_CALL);
		});
	}

	it("ignores spend outside the hourly window", async () => {
		const ledger = ledgerWithTokenSpend(
			LARGE_PROMPT,
			new Date(Date.now() - DOUBLE_HOURS_MS).toISOString(),
		);
		const result = await budgetedStatus(
			{ key: USER_ID, modelScope: "*", period: "hour", tokens: BUDGET_TOKENS },
			ledger,
			ALLOWED_MODEL,
			USER_ID,
		);
		expect(result.status).toBe(HTTP_OK);
	});

	it("ignores spend outside the daily window", async () => {
		const ledger = ledgerWithTokenSpend(
			LARGE_PROMPT,
			new Date(Date.now() - DOUBLE_DAYS_MS).toISOString(),
		);
		const result = await budgetedStatus(
			{ key: USER_ID, modelScope: "*", period: "day", tokens: BUDGET_TOKENS },
			ledger,
			ALLOWED_MODEL,
			USER_ID,
		);
		expect(result.status).toBe(HTTP_OK);
	});

	it("ignores spend outside the monthly window", async () => {
		const ledger = ledgerWithTokenSpend(
			LARGE_PROMPT,
			new Date(Date.now() - FORTY_DAYS_MS).toISOString(),
		);
		const result = await budgetedStatus(
			{ key: USER_ID, modelScope: "*", period: "month", tokens: BUDGET_TOKENS },
			ledger,
			ALLOWED_MODEL,
			USER_ID,
		);
		expect(result.status).toBe(HTTP_OK);
	});

	it("skips rules scoped to another model", async () => {
		const ledger = ledgerWithTokenSpend(LARGE_PROMPT, new Date().toISOString());
		const result = await budgetedStatus(
			{ key: USER_ID, modelScope: OTHER_MODEL, period: "day", tokens: BUDGET_TOKENS },
			ledger,
			ALLOWED_MODEL,
			USER_ID,
		);
		expect(result.status).toBe(HTTP_OK);
		expect(result.calls).toBe(SINGLE_CALL);
	});

	it("skips rules scoped to another user", async () => {
		const ledger = ledgerWithTokenSpend(LARGE_PROMPT, new Date().toISOString());
		const result = await budgetedStatus(
			{ key: OTHER_USER, modelScope: "*", period: "day", tokens: BUDGET_TOKENS },
			ledger,
			ALLOWED_MODEL,
			USER_ID,
		);
		expect(result.status).toBe(HTTP_OK);
		expect(result.calls).toBe(SINGLE_CALL);
	});

	it("allows unpriced usage past a cost limit because cost is unknown", async () => {
		const ledger = ledgerWithTokenSpend(LARGE_PROMPT, new Date().toISOString());
		const result = await budgetedStatus(
			{ costUsd: BUDGET_COST, key: USER_ID, modelScope: "*", period: "day" },
			ledger,
			ALLOWED_MODEL,
			USER_ID,
		);
		expect(result.status).toBe(HTTP_OK);
	});
});
