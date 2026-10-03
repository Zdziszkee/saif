import { mkdirSync, writeFileSync } from "node:fs";

const FORENAMES_URL =
	"https://raw.githubusercontent.com/sigpwned/popular-names-by-country-dataset/main/common-forenames-by-country.csv";
const SURNAMES_URL =
	"https://raw.githubusercontent.com/sigpwned/popular-names-by-country-dataset/main/common-surnames-by-country.csv";

interface NameRow {
	"Localized Name": string;
	"Romanized Name": string;
}

function parseCsv(text: string): NameRow[] {
	const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
	const header = parseLine(lines[0] ?? "");
	const rows: NameRow[] = [];
	for (const line of lines.slice(1)) {
		const cells = parseLine(line);
		const row: Record<string, string> = {};
		header.forEach((key, index) => {
			row[key] = cells[index] ?? "";
		});
		rows.push(row as unknown as NameRow);
	}
	return rows;
}

function parseLine(line: string): string[] {
	const cells: string[] = [];
	let current = "";
	let quoted = false;
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index];
		if (char === '"') {
			quoted = !quoted;
			continue;
		}
		if (char === "," && !quoted) {
			cells.push(current);
			current = "";
			continue;
		}
		current += char ?? "";
	}
	cells.push(current);
	return cells;
}

function uniqueNames(rows: readonly NameRow[]): string[] {
	const names = new Set<string>();
	for (const row of rows) {
		for (const candidate of [row["Romanized Name"], row["Localized Name"]]) {
			const name = candidate?.trim() ?? "";
			if (name.length > 1 && !/^\d+$/.test(name)) {
				names.add(name);
			}
		}
	}
	return [...names].sort((a, b) => a.localeCompare(b));
}

const [forenamesCsv, surnamesCsv] = await Promise.all([
	fetch(FORENAMES_URL).then((response) => response.text()),
	fetch(SURNAMES_URL).then((response) => response.text()),
]);

const payload = {
	forenames: uniqueNames(parseCsv(forenamesCsv)),
	surnames: uniqueNames(parseCsv(surnamesCsv)),
};

mkdirSync("data", { recursive: true });
writeFileSync("data/names.json", `${JSON.stringify(payload, null, "\t")}\n`);
console.log(`forenames: ${payload.forenames.length}, surnames: ${payload.surnames.length}`);
