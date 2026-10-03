import { readFileSync } from "node:fs";
import { parse } from "dotenv";

import { ensureFixtureEnv } from "../scripts/build-fixture-env.ts";

const ENV_PATH = ".env";

ensureFixtureEnv(ENV_PATH);

const values = parse(readFileSync(ENV_PATH, "utf8"));

function requireFixture(name: string): string {
	const value = values[name];
	if (value === undefined || value.length === 0) {
		throw new Error(`missing ${name} in ${ENV_PATH} — run: bun run fixtures:env`);
	}
	return value;
}

export const ApiKeyFixture = requireFixture("FIXTURE_API_KEY");
export const AwsKeyFixture = requireFixture("FIXTURE_AWS_KEY");
export const BearerTokenFixture = requireFixture("FIXTURE_BEARER_TOKEN");
export const GitHubTokenFixture = requireFixture("FIXTURE_GITHUB_TOKEN");
export const JwtFixture = requireFixture("FIXTURE_JWT");
export const PrivateKeyHeaderFixture = requireFixture("FIXTURE_PRIVATE_KEY_HEADER");
export const SlackTokenFixture = requireFixture("FIXTURE_SLACK_TOKEN");
