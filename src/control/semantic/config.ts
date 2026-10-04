/**
 * Semantic-tier (Jev) configuration.
 *
 * `policy.jev.json` at the project root is the canonical home for everything
 * Jev: which binary questions the decision model is asked, their wording and
 * per-check thresholds, the deadline, the decisiveness floor, and the egress
 * truncation cap.
 *
 * It is deliberately a separate file from the policy engine's `policy.json`.
 * That document owns *whether* the semantic tier runs and *how strictly* its
 * evidence maps to verdicts; this one owns *what the model is asked*. Keeping
 * them apart means a Jev change is one edit in one file.
 *
 * `SEMANTIC_DEFAULTS` is loaded from that file at import time and validated, so
 * a malformed edit fails loudly rather than producing half-configured
 * guardrails at request time. Use {@link loadSemanticConfig} to re-read it at
 * runtime (hot reload), and pass explicit values to the classifier factories to
 * override any of it.
 */

import { readFile } from "node:fs/promises";
import { z } from "zod";
import rawConfig from "../../../policy.jev.json" with { type: "json" };

import { validateChecks } from "./checks.ts";
import { SemanticConfigurationError } from "./errors.ts";
import type { SemanticCheck, SemanticFloors } from "./types.ts";

/** Path of the Jev policy document, relative to the project root. */
export const SEMANTIC_POLICY_PATH = "policy.jev.json";

export interface SemanticConfig {
	/** Binary checks evaluated in one `decide()` round trip. */
	checks: readonly SemanticCheck[];
	/** Answers below this decisiveness `max(p, 1 - p)` are treated as uncertain. */
	floors: SemanticFloors;
	/**
	 * User group id -> the check ids that apply to that group. Every check is
	 * available to every group in the shipped document; drop an id to restrict.
	 */
	groups: Readonly<Record<string, readonly string[]>>;
	/** Truncation cap for the content sent to the decision model. */
	maxChars: number;
	/** Jev model id. */
	model: string;
	/** Deadline for one evaluation round trip, in milliseconds. */
	timeoutMs: number;
}

const thresholdLadderSchema = z.object({
	block: z.number().min(0).max(1).optional(),
	flag: z.number().min(0).max(1).optional(),
	redact: z.number().min(0).max(1).optional(),
});

/** Structural shape only; cross-check constraints live in `validateChecks`. */
export const checkShapeSchema = z.object({
	enabled: z.boolean(),
	id: z.string(),
	instructions: z.string(),
	thresholds: z
		.object({
			inbound: thresholdLadderSchema.optional(),
			outbound: thresholdLadderSchema.optional(),
		})
		.optional()
		.default({}),
	type: z.literal("boolean"),
});

/**
 * Lowest useful decisiveness floor. `max(p, 1 - p)` is at least 0.5 for any
 * answer, so a floor of 0.5 accepts everything and nothing below it means
 * anything.
 */
const MIN_DECISIVENESS_FLOOR = 0.5;

const semanticConfigSchema = z.object({
	checks: z.array(checkShapeSchema),
	floors: z.object({
		decisiveness: z.number().min(MIN_DECISIVENESS_FLOOR).max(1),
	}),
	groups: z.record(z.string().min(1), z.array(z.string().min(1))),
	maxChars: z.number().int().positive(),
	model: z.string().min(1),
	timeoutMs: z.number().int().positive(),
});

/**
 * Validate check definitions from an untrusted source (a reloaded
 * `policy.jev.json`, a `--checks` file, a judge's edit). Structural shape
 * first, then the cross-check constraints in `validateChecks`.
 */
export function parseChecks(raw: unknown): SemanticCheck[] {
	const parsed = z.array(checkShapeSchema).safeParse(raw);
	if (!parsed.success) {
		throw new SemanticConfigurationError(
			`semantic: invalid check definitions: ${describeIssues(parsed.error)}`,
		);
	}
	const checks = parsed.data as SemanticCheck[];
	validateChecks(checks);
	return checks;
}

/** Validate a whole semantic config document. */
export function parseSemanticConfig(raw: unknown): SemanticConfig {
	const parsed = semanticConfigSchema.safeParse(raw);
	if (!parsed.success) {
		throw new SemanticConfigurationError(
			`semantic: invalid semantic configuration: ${describeIssues(parsed.error)}`,
		);
	}
	const config = parsed.data as SemanticConfig;
	validateChecks(config.checks);
	validateGroupMappings(config);
	return config;
}

/**
 * Every id a group lists must name a defined check, and a group must not list
 * the same check twice. A dangling id would silently drop a guardrail.
 */
function validateGroupMappings(config: SemanticConfig): void {
	const defined = new Set(config.checks.map((check) => check.id));

	for (const [groupId, ids] of Object.entries(config.groups)) {
		const seen = new Set<string>();
		for (const id of ids) {
			if (!defined.has(id)) {
				throw new SemanticConfigurationError(
					`semantic: group "${groupId}" lists unknown check "${id}"`,
				);
			}
			if (seen.has(id)) {
				throw new SemanticConfigurationError(
					`semantic: group "${groupId}" lists check "${id}" twice`,
				);
			}
			seen.add(id);
		}
	}
}

/**
 * The checks that apply to a user group.
 *
 * An unknown group is a rejection, never a silent fallback to another group's
 * guardrails.
 */
export function checksForGroup(config: SemanticConfig, groupId: string): SemanticCheck[] {
	const ids = config.groups[groupId];
	if (ids === undefined) {
		throw new SemanticConfigurationError(`semantic: unknown user group "${groupId}"`);
	}
	const byId = new Map(config.checks.map((check) => [check.id, check]));
	return ids.flatMap((id) => {
		const check = byId.get(id);
		return check === undefined ? [] : [check];
	});
}

/**
 * Read and validate `policy.jev.json` (or another document) at runtime.
 *
 * Use this for hot reload; `SEMANTIC_DEFAULTS` already holds the values that
 * were valid at startup.
 */
export async function loadSemanticConfig(
	path: string = SEMANTIC_POLICY_PATH,
): Promise<SemanticConfig> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		throw new SemanticConfigurationError(
			`semantic: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
	return parseSemanticConfig(JSON.parse(text));
}

/**
 * The configuration shipped in `policy.jev.json`.
 *
 * Validated on import, so a malformed file fails loudly at startup rather than
 * producing half-configured guardrails at request time.
 */
export const SEMANTIC_DEFAULTS: SemanticConfig = parseSemanticConfig(rawConfig);

function describeIssues(error: z.ZodError): string {
	const first = error.issues[0];
	if (first === undefined) {
		return "unknown validation error";
	}
	const path = first.path.length === 0 ? "" : ` at ${first.path.join(".")}`;
	return `${first.message}${path}`;
}
