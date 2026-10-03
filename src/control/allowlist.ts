/**
 * Model allowlist enforcement (validate stage).
 *
 * The first cheap check in the pipeline: when an interaction names a model,
 * it must appear in the policy allowlist. Seams that carry no model name
 * (plain prompts) pass through — the allowlist constrains model selection,
 * not content.
 */

import type { Control, ControlResult } from "./types.ts";

export interface AllowlistedModel {
	endpoint?: string | undefined;
	name: string;
}

export function createAllowlistControl(models: readonly AllowlistedModel[]): Control {
	const names = new Set(models.map((model) => model.name));
	return {
		id: "allowlist",
		inspect: (interaction): ControlResult => {
			const model = interaction.model;
			if (model === undefined || names.has(model)) {
				return { verdict: "allow" };
			}
			return {
				hit: {
					controlId: "allowlist",
					detail: `model "${model}" is not in the policy allowlist`,
					kind: "model-allowlist",
					verdict: "block",
				},
				verdict: "block",
			};
		},
	};
}
