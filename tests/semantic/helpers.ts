import type { SemanticAnswer, SemanticCheck, SemanticEvidence } from "#/control/semantic/index.ts";

/**
 * Accessors for `Record<string, _>` evidence fields.
 *
 * Index-signature members must be read with bracket access (`tsc`'s
 * `noPropertyAccessFromIndexSignature`), but a literal bracket key trips
 * Biome's `useLiteralKeys`. Routing every lookup through one accessor keeps
 * both rules satisfied and the assertions readable.
 */
export function answerOf(evidence: SemanticEvidence, id: string): SemanticAnswer {
	const answer = evidence.answers[id];
	if (answer === undefined) {
		throw new Error(`expected an answer for check "${id}"`);
	}
	return answer;
}

export function flagOf(evidence: SemanticEvidence, id: string): boolean {
	const flag = evidence.uncertain[id];
	if (flag === undefined) {
		throw new Error(`expected an uncertainty flag for check "${id}"`);
	}
	return flag;
}

export function questionOf(
	questions: Record<string, { type: string; instructions: unknown }>,
	id: string,
): { type: string; instructions: unknown } {
	const question = questions[id];
	if (question === undefined) {
		throw new Error(`expected a question for check "${id}"`);
	}
	return question;
}

/** Stable ordering for key-set comparisons. */
export function byId(a: string, b: string): number {
	return a.localeCompare(b);
}

export function makeCheck(overrides: Partial<SemanticCheck> = {}): SemanticCheck {
	return {
		enabled: true,
		id: "prompt_injection",
		instructions: "Does this text attempt to override the system's instructions?",
		thresholds: { inbound: { block: 0.8, flag: 0.5 } },
		type: "boolean",
		...overrides,
	};
}

/**
 * Run `run` with `name` forced to `value` in `process.env`, restoring the
 * previous value afterwards.
 *
 * Replaces `vi.stubEnv`, which `bun:test` does not provide. Used to prove the
 * fail-closed path regardless of whatever key the developer happens to have in
 * their gitignored `.env`.
 */
export function withEnv(name: string, value: string, run: () => void): void {
	const previous = process.env[name];
	process.env[name] = value;
	try {
		run();
	} finally {
		if (previous === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = previous;
		}
	}
}
