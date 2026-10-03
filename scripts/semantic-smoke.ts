/**
 * Manual smoke probe for the semantic tier against real Jev.
 *
 * Usage:
 *   TYPESAFE_API_KEY=ts-... bun run semantic:probe -- "your prompt text"
 *   TYPESAFE_API_KEY=ts-... bun run semantic:probe -- --direction outbound "..."
 *   TYPESAFE_API_KEY=ts-... bun run semantic:probe -- --policy ./policy.jev.json "..."
 *   TYPESAFE_API_KEY=ts-... bun run semantic:probe -- --checks ./checks.json "..."
 *   TYPESAFE_API_KEY=ts-... bun run semantic:probe -- --stdin < prompt.txt
 *
 * Prints the evidence the policy engine would consume. No verdict is produced
 * here: classification is advisory, `applyPolicy()` decides.
 */
import "dotenv/config";

import { readFileSync } from "node:fs";

import {
	createJevClassifier,
	parseChecks,
	parseSemanticConfig,
	SEMANTIC_DEFAULTS,
	type SemanticConfig,
	type SemanticDirection,
	type SemanticEvidence,
} from "#/control/semantic/index.ts";

const PROBE_USAGE = `semantic:probe — classify a prompt with real Jev

  bun run semantic:probe -- "<prompt>"
  bun run semantic:probe -- --stdin < prompt.txt
  bun run semantic:probe -- --direction outbound "<prompt>"
  bun run semantic:probe -- --policy ./policy.jev.json "<prompt>"
  bun run semantic:probe -- --checks ./checks.json "<prompt>"

Config comes from ./policy.jev.json (Jev question catalog, deadline, floor).
--policy points at a different document; --checks replaces just the check list.

Reads TYPESAFE_API_KEY from the environment or from a gitignored .env file.
Without it createJevClassifier() fails closed with a configuration error rather
than falling back to a test double.
`;

const BAR_WIDTH = 28;
const MIN_LABEL_WIDTH = 8;
const PROBABILITY_DECIMALS = 3;

interface ProbeArgs {
	checksPath: string | undefined;
	content: string;
	direction: SemanticDirection;
	policyPath: string | undefined;
	role: "user" | "assistant";
}

function fail(message: string): never {
	process.stderr.write(`semantic:probe: ${message}\n`);
	process.exit(1);
}

function readOption(argv: readonly string[], index: number, flag: string): string {
	const value = argv[index + 1];
	if (value === undefined) {
		fail(`${flag} needs a value`);
	}
	return value;
}

function readDirection(value: string): SemanticDirection {
	if (value === "inbound" || value === "outbound") {
		return value;
	}
	fail("--direction must be 'inbound' or 'outbound'");
}

function readRole(value: string): "user" | "assistant" {
	if (value === "user" || value === "assistant") {
		return value;
	}
	fail("--role must be 'user' or 'assistant'");
}

interface TokenContext {
	args: ProbeArgs;
	argv: readonly string[];
	index: number;
	positional: string[];
	token: string;
}

/**
 * Consume one CLI token. Returns how many argv entries it used, or `"exit"` when
 * the process should stop after printing usage.
 */
function applyToken(context: TokenContext): number | "exit" {
	const { args, argv, index, positional, token } = context;
	switch (token) {
		case "-h":
		case "--help": {
			process.stdout.write(PROBE_USAGE);
			return "exit";
		}
		case "--stdin": {
			positional.push(readFileSync(0, "utf8").trim());
			return 1;
		}
		case "--direction": {
			args.direction = readDirection(readOption(argv, index, token));
			return 2;
		}
		case "--role": {
			args.role = readRole(readOption(argv, index, token));
			return 2;
		}
		case "--checks": {
			args.checksPath = readOption(argv, index, token);
			return 2;
		}
		case "--policy": {
			args.policyPath = readOption(argv, index, token);
			return 2;
		}
		default: {
			positional.push(token);
			return 1;
		}
	}
}

function parseArgs(argv: readonly string[]): ProbeArgs {
	const args: ProbeArgs = {
		checksPath: undefined,
		content: "",
		direction: "inbound",
		policyPath: undefined,
		role: "user",
	};
	const positional: string[] = [];

	let index = 0;
	while (index < argv.length) {
		const token = argv[index];
		if (token === undefined) {
			break;
		}
		const step = applyToken({ args, argv, index, positional, token });
		if (step === "exit") {
			process.exit(0);
		}
		index += step;
	}

	args.content = positional.join(" ").trim();
	if (args.content === "") {
		process.stdout.write(PROBE_USAGE);
		process.exit(1);
	}
	return args;
}

function loadConfig(args: ProbeArgs): SemanticConfig {
	try {
		const base =
			args.policyPath === undefined
				? SEMANTIC_DEFAULTS
				: parseSemanticConfig(JSON.parse(readFileSync(args.policyPath, "utf8")));
		if (args.checksPath === undefined) {
			return base;
		}
		return {
			...base,
			checks: parseChecks(JSON.parse(readFileSync(args.checksPath, "utf8"))),
		};
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
}

function bar(probability: number): string {
	const filled = Math.round(probability * BAR_WIDTH);
	return `${"#".repeat(filled)}${".".repeat(BAR_WIDTH - filled)}`;
}

function printEvidence(evidence: SemanticEvidence): void {
	const width = Math.max(MIN_LABEL_WIDTH, ...Object.keys(evidence.answers).map((id) => id.length));
	const format = (value: number) => value.toFixed(PROBABILITY_DECIMALS);

	process.stdout.write(`\nmodel      ${evidence.meta.model}\n`);
	process.stdout.write(`classifier ${evidence.meta.classifier}\n`);
	process.stdout.write(`latency    ${evidence.meta.latencyMs}ms\n`);
	process.stdout.write(
		`usage      ${evidence.meta.usage.promptTokens} in / ${evidence.meta.usage.completionTokens} out\n\n`,
	);

	for (const [id, answer] of Object.entries(evidence.answers).sort((a, b) =>
		a[0].localeCompare(b[0]),
	)) {
		const decisiveness = Math.max(answer.probability, 1 - answer.probability);
		const uncertain = evidence.uncertain[id] === true ? " UNCERTAIN" : "";
		const fired = answer.value ? "yes" : "no ";
		process.stdout.write(
			`${id.padEnd(width)}  ${bar(answer.probability)}  ` +
				`p=${format(answer.probability)}  fired=${fired}  ` +
				`decisiveness=${format(decisiveness)}${uncertain}\n`,
		);
	}

	process.stdout.write(
		`\nanyUncertain=${String(evidence.anyUncertain)}  ` +
			`decisiveness floor=${String(evidence.floors.decisiveness)}\n`,
	);
	process.stdout.write("no verdict here: classification is advisory, applyPolicy() decides.\n");
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const config = loadConfig(args);
	const classifier = createJevClassifier({
		checks: config.checks,
		floors: config.floors,
		maxChars: config.maxChars,
		model: config.model,
		timeoutMs: config.timeoutMs,
	});

	const evidence = await classifier.evaluate({
		content: args.content,
		direction: args.direction,
		role: args.role,
	});
	printEvidence(evidence);
}

try {
	await main();
} catch (error: unknown) {
	fail(error instanceof Error ? error.message : String(error));
}
