import { createFileRoute } from "@tanstack/react-router";

import { Badge } from "#/components/ui/badge.tsx";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "#/components/ui/card.tsx";

export const Route = createFileRoute("/")({ component: Home });

const capabilities: Array<{
	category: string;
	description: string;
	title: string;
}> = [
	{
		category: "Governance",
		description:
			"One validated policy document defining controls, thresholds, strictness profiles, and budget rules, with hot-swap reload at runtime.",
		title: "Policy Engine",
	},
	{
		category: "Enforcement",
		description:
			"Interception points for chat prompts, answers, and tool calls that apply allow, redact, block, or escalate verdicts.",
		title: "Interaction Gateway",
	},
	{
		category: "Defense",
		description:
			"Regex and dictionary checks for secrets and PII with typed redaction, model allowlists, and request-shape validation.",
		title: "Deterministic Tier",
	},
	{
		category: "Defense",
		description:
			"Jev-powered typed decisions with calibrated confidence, threshold-testable verdicts, and fail-closed degradation.",
		title: "Semantic Tier",
	},
	{
		category: "Defense",
		description:
			"Known AI-exploit signatures with evasion-resistant matching over raw, canonicalized, and decoded content forms.",
		title: "Signature Feed",
	},
	{
		category: "Observability",
		description:
			"Token and cost accounting per key and window in SQLite, plus an append-only audit trail of every verdict.",
		title: "Budget & Audit",
	},
];

const commands: Array<{ command: string; purpose: string }> = [
	{ command: "bun run dev", purpose: "start the dev server" },
	{ command: "bun run test", purpose: "run the unit tests" },
	{ command: "bun run verify", purpose: "typecheck and lint" },
];

function Home() {
	return (
		<main className="mx-auto flex max-w-5xl flex-col gap-8 p-8">
			<header className="flex flex-col gap-3">
				<Badge className="w-fit">AI Control Layer</Badge>
				<h1 className="text-4xl font-bold tracking-tight">Saif</h1>
				<p className="text-muted-foreground max-w-2xl text-lg">
					Governance and guardrails for agentic AI systems: one policy source, hybrid deterministic
					and semantic defenses, budget enforcement, and a full audit trail.
				</p>
			</header>
			<section aria-label="Try it live">
				<Card>
					<CardHeader>
						<CardTitle>Try it live</CardTitle>
						<CardDescription>
							Every chat prompt, MCP tool call, and guard request flows through one cheap-first
							pipeline.
						</CardDescription>
					</CardHeader>
					<CardContent className="flex flex-col gap-2 text-sm">
						<p>
							<a className="underline" href="/playground">
								Guard playground
							</a>{" "}
							<span className="text-muted-foreground">
								— try allow, redact, block, and escalate paths live.
							</span>
						</p>
						<p>
							<a className="underline" href="/dashboard">
								Security dashboard
							</a>{" "}
							<span className="text-muted-foreground">
								— verdict counts, recent decisions, feed and policy versions.
							</span>
						</p>
						<p>
							<code className="rounded bg-muted px-2 py-1 font-mono">POST /api/guard</code>{" "}
							<span className="text-muted-foreground">
								— the generic guard endpoint (chat, MCP, and custom seams post here).
							</span>
						</p>
						<p>
							<code className="rounded bg-muted px-2 py-1 font-mono">GET /api/audit/export</code>{" "}
							<span className="text-muted-foreground">
								— audit trail as JSONL or CSV for security review.
							</span>
						</p>
					</CardContent>
				</Card>
			</section>
			<section aria-label="Capabilities" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
				{capabilities.map((capability) => (
					<Card key={capability.title}>
						<CardHeader>
							<Badge className="w-fit" variant="outline">
								{capability.category}
							</Badge>
							<CardTitle>{capability.title}</CardTitle>
							<CardDescription>{capability.description}</CardDescription>
						</CardHeader>
					</Card>
				))}
			</section>
			<section aria-label="Getting started">
				<Card>
					<CardHeader>
						<CardTitle>Getting started</CardTitle>
						<CardDescription>Development commands for this repository.</CardDescription>
					</CardHeader>
					<CardContent className="flex flex-col gap-2">
						{commands.map((entry) => (
							<p className="text-sm" key={entry.command}>
								<code className="rounded bg-muted px-2 py-1 font-mono">{entry.command}</code>{" "}
								<span className="text-muted-foreground">{entry.purpose}</span>
							</p>
						))}
						<p className="text-muted-foreground text-sm">
							The MCP endpoint lives at <code className="font-mono">/mcp</code>.
						</p>
					</CardContent>
				</Card>
			</section>
		</main>
	);
}
