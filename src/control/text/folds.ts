/**
 * Fold tables for canonicalization.
 *
 * Applied after NFKD + lowercasing, so keys are lowercase and anything the
 * compatibility decomposition already handles (fullwidth, sub/superscripts,
 * mathematical alphanumerics, precomposed Latin diacritics) never appears
 * here. Values are plain ASCII; multi-character values (ae, ss, th) are
 * supported because every emitted char inherits the same raw offset.
 *
 * Curated for confusables that actually spoof Latin text, not for
 * transliteration quality — CJK and other scripts are intentionally absent.
 *
 * Maps (not records): keys are single non-ASCII characters or digits, which
 * the naming-convention lint rejects as object members.
 */

/** Visually confusable non-ASCII characters folded to their Latin lookalike. */
export const CONFUSABLE_FOLDS: ReadonlyMap<string, string> = new Map([
	["ß", "ss"],
	["æ", "ae"],
	["đ", "d"],
	["ħ", "h"],
	["ı", "i"],
	["ł", "l"],
	["ŋ", "n"],
	["œ", "oe"],
	["ø", "o"],
	["þ", "th"],
	["а", "a"],
	["е", "e"],
	["и", "u"],
	["к", "k"],
	["м", "m"],
	["н", "h"],
	["о", "o"],
	["р", "p"],
	["с", "c"],
	["т", "t"],
	["у", "y"],
	["х", "x"],
	["ё", "e"],
	["і", "i"],
	["ј", "j"],
	["ѕ", "s"],
	["α", "a"],
	["ε", "e"],
	["η", "n"],
	["ι", "i"],
	["κ", "k"],
	["μ", "u"],
	["ν", "v"],
	["ο", "o"],
	["ρ", "p"],
	["τ", "t"],
	["υ", "u"],
	["ω", "w"],
	["χ", "x"],
]);

/** Leetspeak substitutions applied to ASCII digits and symbols. */
export const LEET_FOLDS: ReadonlyMap<string, string> = new Map([
	["$", "s"],
	["+", "t"],
	["0", "o"],
	["1", "l"],
	["3", "e"],
	["4", "a"],
	["5", "s"],
	["6", "g"],
	["7", "t"],
	["8", "b"],
	["9", "g"],
	["@", "a"],
	["|", "l"],
]);
