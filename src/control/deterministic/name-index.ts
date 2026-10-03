import namesData from "../../../data/names.json" with { type: "json" };

export interface NameMatch {
	end: number;
	start: number;
	value: string;
}

interface Token {
	end: number;
	particle: boolean;
	start: number;
	value: string;
}

const FeminineSuffixLength = 3;
const MaxRunWords = 4;
const MaxTokenGap = 2;

function normalize(value: string): string {
	return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function buildSet(names: readonly string[]): ReadonlySet<string> {
	const set = new Set<string>();
	for (const name of names) {
		const normalized = normalize(name);
		if (normalized.length > 0) {
			set.add(normalized);
		}
	}
	return set;
}

function buildSurnameSet(names: readonly string[]): ReadonlySet<string> {
	const set = new Set<string>(buildSet(names));
	for (const name of [...set]) {
		if (name.endsWith("ski")) {
			set.add(`${name.slice(0, -FeminineSuffixLength)}ska`);
		} else if (name.endsWith("cki")) {
			set.add(`${name.slice(0, -FeminineSuffixLength)}cka`);
		}
	}
	return set;
}

const forenameIndex = buildSet(namesData.forenames);
const surnameIndex = buildSurnameSet(namesData.surnames);

const possessiveSuffix = /['’]s$/u;

function lookup(set: ReadonlySet<string>, value: string): boolean {
	return set.has(normalize(value.replace(possessiveSuffix, "")));
}

function trimmedEnd(token: Token): number {
	const kept = token.value.replace(possessiveSuffix, "");
	return token.end - (token.value.length - kept.length);
}

export function isKnownFirstName(token: string): boolean {
	return lookup(forenameIndex, token);
}

export function isKnownSurname(token: string): boolean {
	return lookup(surnameIndex, token);
}

const capitalizedWord = /\p{Lu}[\p{L}'’-]*/gu;
const surnameParticles = new Set([
	"al",
	"bin",
	"da",
	"das",
	"de",
	"del",
	"della",
	"den",
	"der",
	"di",
	"do",
	"dos",
	"du",
	"el",
	"ibn",
	"la",
	"le",
	"op",
	"ten",
	"ter",
	"van",
	"von",
]);
const lowercaseWord = /[\p{Ll}'’-]+/gu;

function tokenize(text: string): Token[] {
	const tokens: Token[] = [];
	for (const match of text.matchAll(capitalizedWord)) {
		const value = match[0];
		const start = match.index;
		if (value === undefined || start === undefined) {
			continue;
		}
		tokens.push({ end: start + value.length, particle: false, start, value });
	}
	for (const match of text.matchAll(lowercaseWord)) {
		const value = match[0];
		const start = match.index;
		if (value === undefined || start === undefined) {
			continue;
		}
		if (surnameParticles.has(normalize(value))) {
			tokens.push({ end: start + value.length, particle: true, start, value });
		}
	}
	return tokens.sort((a, b) => a.start - b.start);
}

function runsOf(tokens: readonly Token[]): Token[][] {
	const runs: Token[][] = [];
	let current: Token[] = [];
	for (const token of tokens) {
		const previous = current.at(-1);
		if (previous !== undefined && token.start - previous.end > MaxTokenGap) {
			runs.push(current);
			current = [];
		}
		current.push(token);
	}
	if (current.length > 0) {
		runs.push(current);
	}
	return runs;
}

function phraseIn(set: ReadonlySet<string>, tokens: readonly Token[]): boolean {
	if (tokens.length === 0) {
		return false;
	}
	const joined = tokens.map((token) => token.value).join(" ");
	if (lookup(set, joined)) {
		return true;
	}
	return tokens.every((token) => !token.particle && lookup(set, token.value));
}

function matchAt(run: readonly Token[], from: number, text: string): NameMatch | null {
	const available = Math.min(run.length - from, MaxRunWords);
	for (let words = available; words >= 2; words -= 1) {
		const slice = run.slice(from, from + words);
		for (let split = 1; split <= words - 1; split += 1) {
			const forePart = slice.slice(0, split);
			const surPart = slice.slice(split);
			const first = slice[0];
			const surLast = surPart.at(-1);
			if (first === undefined || surLast === undefined) {
				continue;
			}
			if (first.particle || surLast.particle) {
				continue;
			}
			if (!(phraseIn(forenameIndex, forePart) && phraseIn(surnameIndex, surPart))) {
				continue;
			}
			const end = trimmedEnd(surLast);
			return { end, start: first.start, value: text.slice(first.start, end) };
		}
	}
	return null;
}

export function matchKnownNames(text: string): NameMatch[] {
	const matches: NameMatch[] = [];
	for (const run of runsOf(tokenize(text))) {
		let index = 0;
		while (index < run.length) {
			const match = matchAt(run, index, text);
			if (match === null) {
				index += 1;
				continue;
			}
			matches.push(match);
			while (index < run.length && (run.at(index)?.start ?? 0) < match.end) {
				index += 1;
			}
		}
	}
	return matches;
}
