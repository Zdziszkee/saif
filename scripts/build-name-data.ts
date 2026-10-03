import { mkdirSync, writeFileSync } from "node:fs";

const FORENAMES_URL =
	"https://raw.githubusercontent.com/sigpwned/popular-names-by-country-dataset/main/common-forenames-by-country.csv";
const SURNAMES_URL =
	"https://raw.githubusercontent.com/sigpwned/popular-names-by-country-dataset/main/common-surnames-by-country.csv";

interface NameRow {
	"Localized Name": string;
	"Romanized Name": string;
}

const lineEnding = /\r?\n/;
const digitsOnly = /^\d+$/u;

function parseCsv(text: string): NameRow[] {
	const lines = text.split(lineEnding).filter((line) => line.length > 0);
	const header = parseLine(lines[0] ?? "");
	const rows: NameRow[] = [];
	for (const line of lines.slice(1)) {
		const cells = parseLine(line);
		const row: Record<string, string> = {};
		for (const [index, key] of header.entries()) {
			row[key] = cells[index] ?? "";
		}
		rows.push(row as unknown as NameRow);
	}
	return rows;
}

function parseLine(line: string): string[] {
	const cells: string[] = [];
	let current = "";
	let quoted = false;
	for (const char of line) {
		if (char === '"') {
			quoted = !quoted;
			continue;
		}
		if (char === "," && !quoted) {
			cells.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	cells.push(current);
	return cells;
}

function uniqueNames(rows: readonly NameRow[]): string[] {
	const names = new Set<string>();
	for (const row of rows) {
		for (const candidate of [row["Romanized Name"], row["Localized Name"]]) {
			const name = candidate?.trim() ?? "";
			if (name.length > 1 && !digitsOnly.test(name)) {
				names.add(name);
			}
		}
	}
	return [...names].sort((a, b) => a.localeCompare(b));
}

export async function downloadText(url: string, fetcher: typeof fetch = fetch): Promise<string> {
	const response = await fetcher(url);
	if (!response.ok) {
		throw new Error(`name data download failed: ${url} -> HTTP ${response.status}`);
	}
	const text = await response.text();
	if (text.trim().length === 0) {
		throw new Error(`name data download empty: ${url}`);
	}
	return text;
}

export function buildNameJson(forenamesCsv: string, surnamesCsv: string): string {
	const payload = {
		forenames: uniqueNames(parseCsv(forenamesCsv)),
		surnames: uniqueNames(parseCsv(surnamesCsv)),
	};
	if (payload.forenames.length === 0 || payload.surnames.length === 0) {
		throw new Error("name data parsed to an empty index");
	}
	return `${JSON.stringify(payload, null, "\t")}\n`;
}

export async function main(): Promise<void> {
	const [forenamesCsv, surnamesCsv] = await Promise.all([
		downloadText(FORENAMES_URL),
		downloadText(SURNAMES_URL),
	]);
	const document = buildNameJson(forenamesCsv, surnamesCsv);
	mkdirSync("data", { recursive: true });
	writeFileSync("data/names.json", document);
	const payload = JSON.parse(document) as { forenames: string[]; surnames: string[] };
	console.log(`forenames: ${payload.forenames.length}, surnames: ${payload.surnames.length}`);
}

if (process.argv[1]?.endsWith("build-name-data.ts") ?? false) {
	await main();
}
