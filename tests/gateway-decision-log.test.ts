import { describe, expect, it } from "bun:test";
import type { DecisionLogInput } from "#/gateway/decision-log.ts";
import { formatDecisionLine } from "#/gateway/decision-log.ts";

const BASE_INPUT: DecisionLogInput = {
	groupId: "students",
	hits: [],
	outcome: "allow",
	timestamp: "2026-10-04T12:00:00.000Z",
	userId: "user-1",
};

describe("formatDecisionLine", () => {
	it("renders identity, direction, model, and outcome in stable order", () => {
		const line = formatDecisionLine({
			...BASE_INPUT,
			blockingControl: "pipeline",
			direction: "inbound",
			model: "gpt-4o",
			outcome: "allow",
		});
		expect(line).toContain("user=user-1");
		expect(line).toContain("group=students");
		expect(line).toContain("dir=inbound");
		expect(line).toContain("model=gpt-4o");
		expect(line).toContain("outcome=allow");
		const order = ["user=", "group=", "dir=", "model=", "outcome=", "hits="].map((token) =>
			line.indexOf(token),
		);
		const sorted = [...order].sort((left, right) => left - right);
		expect(order).toEqual(sorted);
	});

	it("marks redacted and flagged turns for log grep", () => {
		const line = formatDecisionLine({
			...BASE_INPUT,
			blockingControl: "deterministic-pii",
			flagged: true,
			hits: [{ controlId: "deterministic-pii", kind: "pii.email", verdict: "redact" }],
			outcome: "redact",
		});
		expect(line).toContain("outcome=redact+flagged");
		expect(line).toContain("flagged");
		expect(line).toContain("blocking=deterministic-pii");
		expect(line).toContain("deterministic-pii/pii.email:redact");
		expect(line).not.toContain("\n");
	});

	it("marks blocked and escalated turns with the blocking control", () => {
		const blocked = formatDecisionLine({
			...BASE_INPUT,
			blockingControl: "semantic-checks",
			hits: [{ controlId: "semantic-checks", kind: "semantic", verdict: "block" }],
			outcome: "block",
		});
		expect(blocked).toContain("outcome=block");
		expect(blocked).toContain("blocking=semantic-checks");
		const escalated = formatDecisionLine({ ...BASE_INPUT, outcome: "escalate" });
		expect(escalated).toContain("escalate");
	});

	it("renders per-hit probability scores only when numeric", () => {
		const line = formatDecisionLine({
			...BASE_INPUT,
			hits: [
				{ controlId: "semantic-checks", kind: "semantic", score: 0.923_456, verdict: "flag" },
				{ controlId: "allowlist", kind: "allowlist", verdict: "allow" },
			],
			outcome: "allow",
			semanticDetail: "unknown group intent with p=0.92",
		});
		expect(line).toContain("semantic-checks/semantic:flag score=0.9235");
		expect(line).toContain("allowlist/allowlist:allow");
		expect(line).toContain('semantic="unknown group intent with p=0.92"');
	});

	it("ignores non-numeric scores without emitting a score token", () => {
		const line = formatDecisionLine({
			...BASE_INPUT,
			hits: [{ controlId: "semantic-checks", kind: "semantic", score: "high", verdict: "flag" }],
			outcome: "allow",
		});
		expect(line).not.toContain("score=");
	});

	it("renders token usage and cost when budget settles", () => {
		const line = formatDecisionLine({
			...BASE_INPUT,
			budget: { completionTokens: 80, costUsd: 0.001_234, outcome: "ok", promptTokens: 120 },
			outcome: "allow",
		});
		expect(line).toContain("budget=ok");
		expect(line).toContain("tokens=120+80=200");
		expect(line).toContain("cost=0.001234");
	});

	it("renders unpriced usage without fabricating a zero cost", () => {
		const line = formatDecisionLine({
			...BASE_INPUT,
			budget: { completionTokens: 10, costUsd: null, promptTokens: 20 },
			outcome: "allow",
		});
		expect(line).toContain("cost=unpriced");
	});

	it("renders empty hits as none", () => {
		expect(formatDecisionLine(BASE_INPUT)).toContain("hits=none");
	});

	it("renders upstream failure outcomes for grep", () => {
		const line = formatDecisionLine({
			...BASE_INPUT,
			outcome: "allow",
			upstream: { detail: "connection reset", outcome: "upstream-failure", status: 502 },
		});
		expect(line).toContain("upstream=upstream-failure");
		expect(line).toContain("status=502");
		expect(line).toContain('upstream-detail="connection reset"');
	});

	it("degrades malformed fields to safe tokens instead of throwing", () => {
		const malformed = {
			flagged: "yes",
			groupId: null,
			hits: "nope",
			outcome: "bogus-verdict",
			userId: 42,
		} as unknown as DecisionLogInput;
		const line = formatDecisionLine(malformed);
		expect(line).toContain("user=unknown");
		expect(line).toContain("group=unknown");
		expect(line).toContain("outcome=unknown");
		expect(line).toContain("hits=invalid");
	});

	it("truncates oversized attacker-controlled text and stays single-line", () => {
		const huge = "A".repeat(500);
		const line = formatDecisionLine({
			...BASE_INPUT,
			hits: [{ controlId: "signatures", detail: huge, kind: "prompt-injection", verdict: "block" }],
			outcome: "block",
			semanticDetail: `first line\nsecond line\t${huge}`,
		});
		expect(line).not.toContain("\n");
		expect(line).not.toContain("\t");
		expect(line).not.toContain(huge);
		expect(line).toContain("...");
	});

	it("keeps the line bounded when hit lists are unbounded", () => {
		const hits = Array.from({ length: 40 }, (_, index) => ({
			controlId: `control-${String(index)}`,
			kind: "semantic",
			verdict: "flag",
		}));
		const line = formatDecisionLine({ ...BASE_INPUT, hits, outcome: "allow" });
		expect(line).toContain("-more");
		expect(line).not.toContain("control-39/semantic:flag");
	});
});
