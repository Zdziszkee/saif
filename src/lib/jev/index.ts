/**
 * Public alias for the Jev semantic-tier configuration.
 *
 * `src/control/semantic/` is canonical: every check definition, threshold,
 * and loader lives there. This module re-exports the read-only config
 * surface so callers outside the control layer can resolve group checks and
 * parse config documents without reaching into control internals.
 */

// biome-ignore lint/performance/noBarrelFile: this module is the public alias for the canonical semantic config surface
export {
	checksForGroup,
	loadSemanticConfig,
	parseSemanticConfig,
} from "#/control/semantic/config.ts";
