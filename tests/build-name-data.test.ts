import { describe, expect, it } from "bun:test";

import { buildNameJson, downloadText } from "../scripts/build-name-data.ts";

function stubFetcher(options: { ok: boolean; status: number; text: string }): typeof fetch {
	return (async () =>
		Promise.resolve({
			ok: options.ok,
			status: options.status,
			text: async () => options.text,
		})) as unknown as typeof fetch;
}

const HeaderRow =
	"Country,Country Group,Region,Population,Note,Year,Romanization,Index,Name Group,Gender,Localized Name,Romanized Name";
const SampleRows = `${HeaderRow}\nPL,1,,,,2024,N,1,N-PL-1-M-1,M,Jan,Jan\nPL,1,,,,2024,N,2,N-PL-2-F-1,F,Kowalska,Kowalska`;

describe("name data download", () => {
	it("rejects HTTP errors instead of writing garbage", async () => {
		const fetcher = stubFetcher({ ok: false, status: 404, text: "" });
		await expect(downloadText("https://example.invalid/names.csv", fetcher)).rejects.toThrow();
	});

	it("rejects empty bodies", async () => {
		const fetcher = stubFetcher({ ok: true, status: 200, text: "   " });
		await expect(downloadText("https://example.invalid/names.csv", fetcher)).rejects.toThrow();
	});

	it("builds a sorted unique index from CSV rows", () => {
		const document = buildNameJson(SampleRows, SampleRows);
		const payload = JSON.parse(document) as { forenames: string[]; surnames: string[] };
		expect(payload.forenames).toContain("Jan");
		expect(payload.surnames).toContain("Kowalska");
	});

	it("refuses to emit an empty index", () => {
		expect(() => buildNameJson(HeaderRow, HeaderRow)).toThrow();
	});
});
