import type { WireNoulQuestion } from "@tanstack/ai/adapters";

import { SemanticConfigurationError } from "./errors.ts";
import type { SemanticCheck, ThresholdLadder } from "./types.ts";

/** `decide()` reserves this question key for its own result metadata. */
export const RESERVED_QUESTION_KEY = "meta";

/**
 * Validate a policy-authored check list. Throws `SemanticConfigurationError`
 * on anything that would produce an unusable question map.
 */
export function validateChecks(checks: readonly SemanticCheck[]): void {
	validateNonEmpty(checks);
	validateUniqueIds(checks);
	for (const check of checks) {
		validateCheck(check);
	}
}

function validateNonEmpty(checks: readonly SemanticCheck[]): void {
	if (checks.length === 0) {
		throw new SemanticConfigurationError("semantic: at least one check is required");
	}
}

function validateUniqueIds(checks: readonly SemanticCheck[]): void {
	const seen = new Set<string>();
	for (const check of checks) {
		if (check.id === RESERVED_QUESTION_KEY) {
			throw new SemanticConfigurationError(
				`semantic: check id "${RESERVED_QUESTION_KEY}" is reserved by decide()`,
			);
		}
		if (check.id.trim() === "") {
			throw new SemanticConfigurationError("semantic: check id must not be empty");
		}
		if (seen.has(check.id)) {
			throw new SemanticConfigurationError(`semantic: duplicate check id "${check.id}"`);
		}
		seen.add(check.id);
	}
}

function validateCheck(check: SemanticCheck): void {
	if (check.type !== "boolean") {
		throw new SemanticConfigurationError(
			`semantic: check "${check.id}" has unsupported type "${String(check.type)}"; only "boolean" is supported`,
		);
	}
	if (check.instructions.trim() === "") {
		throw new SemanticConfigurationError(
			`semantic: check "${check.id}" needs non-empty instructions`,
		);
	}
	validateThresholdLadder(check.id, "inbound", check.thresholds.inbound);
	validateThresholdLadder(check.id, "outbound", check.thresholds.outbound);
}

function validateThresholdLadder(
	checkId: string,
	direction: string,
	ladder: ThresholdLadder | undefined,
): void {
	if (ladder === undefined) {
		return;
	}
	for (const [action, threshold] of Object.entries(ladder)) {
		if (typeof threshold !== "number" || threshold < 0 || threshold > 1) {
			throw new SemanticConfigurationError(
				`semantic: check "${checkId}" has invalid ${direction} "${action}" threshold; expected a number between 0 and 1`,
			);
		}
	}
}

/**
 * Build the question map for `decide()` from the policy's enabled checks.
 *
 * Every enabled check becomes one binary (TypeSafe `noul`) question keyed by the
 * check id, so a single `decide()` round trip answers the whole policy.
 */
export function buildQuestions(checks: readonly SemanticCheck[]): Record<string, WireNoulQuestion> {
	validateChecks(checks);

	const questions: Record<string, WireNoulQuestion> = {};
	for (const check of checks) {
		if (!check.enabled) {
			continue;
		}
		// A binary check is a TypeSafe `noul` question. Built as a literal rather
		// than via `@tanstack/ai`'s `boolean()` helper, whose `criteria?: undefined`
		// return type is not assignable under `exactOptionalPropertyTypes`.
		questions[check.id] = { instructions: check.instructions, type: "noul" };
	}

	if (Object.keys(questions).length === 0) {
		throw new SemanticConfigurationError("semantic: no enabled checks to evaluate");
	}
	return questions;
}

/** Ids of the checks `buildQuestions` would actually send. */
export function enabledCheckIds(checks: readonly SemanticCheck[]): string[] {
	return checks.filter((check) => check.enabled).map((check) => check.id);
}
