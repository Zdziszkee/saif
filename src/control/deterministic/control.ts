import type { z } from "zod";
import type {
	actionSchema,
	DetectionRule,
	detectionConfigSchema,
} from "#/control/policy/schema.ts";
import { patternComplexityProblem } from "#/control/policy/schema.ts";
import type {
	Control,
	ControlHit,
	ControlResult,
	Direction,
	RedactionSpan,
	Verdict,
} from "../types.ts";
import { OUTCOME_SEVERITY } from "../types.ts";
import {
	type BuiltinFamily,
	builtinFamilies,
	type Detection,
	detectSensitive,
	type Span,
} from "./detectors.ts";
import { customPlaceholder, placeholderFor } from "./placeholders.ts";

type DetectionConfig = z.infer<typeof detectionConfigSchema>;
type ControlAction = z.infer<typeof actionSchema>;

interface CompiledRule {
	readonly action: ControlAction;
	readonly directions: readonly Direction[];
	readonly id: string;
	readonly kind: string;
	readonly regex: RegExp;
}

interface Finding {
	readonly action: ControlAction;
	readonly detectorId: string;
	readonly kind: string;
	readonly placeholder: string | null;
	readonly span: Span;
}

function enabledFamilies(builtins: DetectionConfig["builtins"]): BuiltinFamily[] {
	return builtinFamilies.filter((family) => builtins[family]);
}

function compileRules(rules: readonly DetectionRule[]): CompiledRule[] {
	const compiled: CompiledRule[] = [];
	for (const rule of rules) {
		if (patternComplexityProblem(rule.pattern) !== "") {
			continue;
		}
		compiled.push({
			action: rule.action,
			directions: rule.directions,
			id: rule.id,
			kind: rule.kind,
			regex: new RegExp(rule.pattern, "gi"),
		});
	}
	return compiled;
}

function indexPersons(detections: readonly Detection[]): Map<string, number> {
	const ordered = [...detections]
		.filter((detection) => detection.type === "person")
		.sort((a, b) => a.span.start - b.span.start);
	const index = new Map<string, number>();
	for (const detection of ordered) {
		if (!index.has(detection.value)) {
			index.set(detection.value, index.size + 1);
		}
	}
	return index;
}

function builtinFindings(
	detections: readonly Detection[],
	defaults: DetectionConfig["defaultActions"],
): Finding[] {
	const persons = indexPersons(detections);
	const suspectKind = "suspect";
	const findings: Finding[] = [];
	for (const detection of detections) {
		const action = detection.validated
			? (defaults[detection.kind] ?? "flag")
			: (defaults[suspectKind] ?? defaults[detection.kind] ?? "flag");
		if (action === "allow") {
			continue;
		}
		findings.push({
			action,
			detectorId: detection.detectorId,
			kind: `${detection.kind}.${detection.type}`,
			placeholder:
				action === "redact"
					? placeholderFor(detection.type, detection.value, persons.get(detection.value) ?? 1)
					: null,
			span: detection.span,
		});
	}
	return findings;
}

function ruleFindings(
	content: string,
	direction: Direction,
	rules: readonly CompiledRule[],
): Finding[] {
	const findings: Finding[] = [];
	for (const rule of rules) {
		if (!rule.directions.includes(direction)) {
			continue;
		}
		rule.regex.lastIndex = 0;
		for (const match of content.matchAll(rule.regex)) {
			const value = match[0];
			const start = match.index;
			if (value === undefined || start === undefined) {
				continue;
			}
			if (rule.action === "allow") {
				continue;
			}
			findings.push({
				action: rule.action,
				detectorId: rule.id,
				kind: rule.kind,
				placeholder: rule.action === "redact" ? customPlaceholder(rule.id) : null,
				span: { end: start + value.length, start },
			});
		}
	}
	return findings;
}

function decideResult(findings: readonly Finding[]): ControlResult {
	if (findings.length === 0) {
		return { verdict: "allow" };
	}
	let worst: ControlAction = "allow";
	let worstKind = "";
	for (const finding of findings) {
		if (OUTCOME_SEVERITY[finding.action] > OUTCOME_SEVERITY[worst]) {
			worst = finding.action;
			worstKind = finding.kind;
		}
	}
	const verdict: Verdict = worst === "flag" ? "allow" : worst;
	const hit: ControlHit = {
		controlId: "deterministic",
		detail: `findings: ${[...new Set(findings.map((finding) => finding.detectorId))].join(", ")}`,
		kind: worstKind,
		verdict: worst === "flag" ? "flag" : worst,
	};
	const redactions: RedactionSpan[] = [];
	for (const finding of findings) {
		if (finding.action === "redact" && finding.placeholder !== null) {
			redactions.push({
				detectorId: finding.detectorId,
				end: finding.span.end,
				kind: finding.kind,
				placeholder: finding.placeholder,
				start: finding.span.start,
			});
		}
	}
	return {
		flagged: findings.some((finding) => finding.action === "flag"),
		...(redactions.length > 0 ? { redactions } : {}),
		hit,
		verdict,
	};
}

/** Deterministic detection tier behind the {@link Control} seam. */
export function createDeterministicControl(config: DetectionConfig): Control {
	const families = enabledFamilies(config.builtins);
	const rules = compileRules(config.rules);
	const defaults = config.defaultActions;

	return {
		id: "deterministic",
		inspect: (interaction): ControlResult => {
			const detections =
				families.length === 0 ? [] : detectSensitive(interaction.content, families);
			return decideResult([
				...builtinFindings(detections, defaults),
				...ruleFindings(interaction.content, interaction.direction, rules),
			]);
		},
	};
}
