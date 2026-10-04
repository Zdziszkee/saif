import { describe, expect, it } from "bun:test";
import { file, Glob } from "bun";

/**
 * Regression: `v1.chat-completions.ts` and `v1.chat.completions.ts` both
 * normalized to `V1ChatCompletionsRoute`, so the generated tree declared the
 * import and the const twice and `bun run dev` crashed with a PARSE_ERROR.
 * The canonical route is the dotted OpenAI-compatible
 * `POST /v1/chat/completions`.
 */
const CANONICAL_ROUTE_FILE = "v1.chat.completions.ts";
const CANONICAL_IMPORT_SOURCE = "./routes/v1.chat.completions";
const CANONICAL_REGISTRATION = 'createFileRoute("/v1/chat/completions")';
const HYPHENATED_REGISTRATION = 'createFileRoute("/v1/chat-completions")';
const ROUTES_DIR = "src/routes";
const ROUTE_TREE = "src/routeTree.gen.ts";

async function scanRouteFiles(pattern: string): Promise<string[]> {
	const names: string[] = [];
	const glob = new Glob(pattern);
	for await (const entry of glob.scan({ cwd: ROUTES_DIR })) {
		names.push(entry);
	}
	return [...names].sort();
}

describe("v1 chat route tree", () => {
	it("keeps exactly one v1 chat route file", async () => {
		expect(await scanRouteFiles("v1.chat*.ts")).toEqual([CANONICAL_ROUTE_FILE]);
	});

	it("declares the chat route once in the generated tree", async () => {
		const tree = await file(ROUTE_TREE).text();
		const imports = tree.match(/^import .*V1ChatCompletionsRouteImport.*$/gm) ?? [];
		expect(imports).toHaveLength(1);
		expect(imports.at(0)).toContain(CANONICAL_IMPORT_SOURCE);
		const declarations = tree.match(/^const V1ChatCompletionsRoute =.*$/gm) ?? [];
		expect(declarations).toHaveLength(1);
	});

	it("registers the OpenAI-compatible chat path", async () => {
		const text = await file(`${ROUTES_DIR}/${CANONICAL_ROUTE_FILE}`).text();
		expect(text).toContain(CANONICAL_REGISTRATION);
	});

	it("registers no hyphenated chat path", async () => {
		const names = await scanRouteFiles("**/*.ts");
		const hits = await Promise.all(
			names.map(async (name) => {
				const text = await file(`${ROUTES_DIR}/${name}`).text();
				return text.includes(HYPHENATED_REGISTRATION) ? name : null;
			}),
		);
		expect(hits.filter((hit) => hit !== null)).toEqual([]);
	});
});
