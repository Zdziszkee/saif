import { AllowlistEditor } from "#/components/controls/allowlist-editor.tsx";
import { DetectionEditor } from "#/components/controls/detection-editor.tsx";
import { GeneralForm } from "#/components/controls/general-form.tsx";
import { JevChecksEditor } from "#/components/controls/jev-checks-editor.tsx";
import { ProfilesEditor } from "#/components/controls/profiles-editor.tsx";
import { TierStatusBanner } from "#/components/tier-status.tsx";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "#/components/ui/card.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs.tsx";
import type { Policy } from "#/control/policy/schema.ts";
import { SEMANTIC_DEFAULTS, type SemanticConfig } from "#/control/semantic/config.ts";

export interface SaveIssue {
	message: string;
	path: string;
}

export function PageHeader() {
	return (
		<header className="flex flex-col gap-2">
			<Badge className="w-fit">Policy editor</Badge>
			<h1 className="text-3xl font-bold tracking-tight">Controls</h1>
			<p className="text-muted-foreground text-sm">
				Edit the safe policy subsets — general switches, detection rules, JEV decision-model checks,
				the model allowlist, and strictness profiles. Saving sends the full document with its base
				version; stale writers are rejected so concurrent edits never silently overwrite each other.
			</p>
		</header>
	);
}

export function LoadingView({ error, onRetry }: { error: string | null; onRetry: () => void }) {
	if (error === null) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>Loading policy…</CardTitle>
				</CardHeader>
			</Card>
		);
	}
	return (
		<Card>
			<CardHeader>
				<CardTitle>Policy unavailable</CardTitle>
				<CardDescription>{error}</CardDescription>
			</CardHeader>
			<CardContent>
				<Button onClick={onRetry} type="button">
					Retry
				</Button>
			</CardContent>
		</Card>
	);
}

export function StatusBar({
	dirty,
	onDiscard,
	onSave,
	saving,
	semanticVersion,
	version,
}: {
	dirty: boolean;
	onDiscard: () => void;
	onSave: () => void;
	saving: boolean;
	semanticVersion?: string | undefined;
	version: string;
}) {
	return (
		<div className="flex flex-wrap items-center gap-2">
			<Badge variant="outline">policy v{version}</Badge>
			{semanticVersion === undefined || semanticVersion.trim().length === 0 ? null : (
				<Badge variant="outline">jev v{semanticVersion}</Badge>
			)}
			{dirty ? (
				<Badge variant="secondary">Unsaved changes</Badge>
			) : (
				<Badge variant="outline">Saved</Badge>
			)}
			<div className="ml-auto flex gap-2">
				<Button disabled={!dirty || saving} onClick={onDiscard} type="button" variant="outline">
					Discard
				</Button>
				<Button disabled={!dirty || saving} onClick={onSave} type="button">
					{saving ? "Saving…" : "Save changes"}
				</Button>
			</div>
		</div>
	);
}

export function IssuesCard({ issues }: { issues: readonly SaveIssue[] }) {
	if (issues.length === 0) {
		return null;
	}
	return (
		<Card>
			<CardHeader>
				<CardTitle>Policy issues</CardTitle>
				<CardDescription>The server rejected the saved document.</CardDescription>
			</CardHeader>
			<CardContent>
				<ul className="flex flex-col gap-1" role="alert">
					{issues.map((issue) => (
						<li className="text-sm" key={`${issue.path}:${issue.message}`}>
							<span className="font-mono">{issue.path.length > 0 ? issue.path : "(root)"}</span>
							{`: ${issue.message}`}
						</li>
					))}
				</ul>
			</CardContent>
		</Card>
	);
}

export function EditorTabs({
	defaultTab,
	draft,
	jevDraft,
	onDraftChange,
	onJevChange,
}: {
	defaultTab?: string | undefined;
	draft: Policy;
	jevDraft?: SemanticConfig | undefined;
	onDraftChange: (next: Policy) => void;
	onJevChange?: ((next: SemanticConfig) => void) | undefined;
}) {
	// The JEV catalog is always visible, even with no TYPESAFE_API_KEY: a
	// missing draft (tier off, or the JEV document still loading) falls back
	// to the shipped defaults so the tab never dead-ends at "unavailable".
	// The live tier banner above the editor reports live/mock/off + reason.
	const effectiveJevDraft = jevDraft ?? SEMANTIC_DEFAULTS;
	return (
		<Tabs defaultValue={defaultTab ?? "general"}>
			<TabsList>
				<TabsTrigger value="allowlist">Allowlist</TabsTrigger>
				<TabsTrigger value="detection">Detection</TabsTrigger>
				<TabsTrigger value="jev">JEV checks</TabsTrigger>
				<TabsTrigger value="general">General</TabsTrigger>
				<TabsTrigger value="profiles">Profiles</TabsTrigger>
			</TabsList>
			<TabsContent value="allowlist">
				<AllowlistEditor draft={draft} onChange={onDraftChange} />
			</TabsContent>
			<TabsContent value="detection">
				<DetectionEditor draft={draft} onChange={onDraftChange} />
			</TabsContent>
			<TabsContent value="jev">
				<div className="flex flex-col gap-4">
					<TierStatusBanner />
					<JevChecksEditor draft={effectiveJevDraft} onChange={onJevChange ?? noopJevChange} />
				</div>
			</TabsContent>
			<TabsContent value="general">
				<GeneralForm draft={draft} onChange={onDraftChange} />
			</TabsContent>
			<TabsContent value="profiles">
				<ProfilesEditor draft={draft} onChange={onDraftChange} />
			</TabsContent>
		</Tabs>
	);
}

function noopJevChange(): void {
	// Intentionally drops edits when no JEV handler is wired: the catalog
	// stays visible (read-only) instead of dead-ending at "unavailable".
}

export function StickyBar({
	dirty,
	onDiscard,
	onSave,
	saving,
}: {
	dirty: boolean;
	onDiscard: () => void;
	onSave: () => void;
	saving: boolean;
}) {
	if (!dirty) {
		return null;
	}
	return (
		<div className="sticky bottom-4 flex flex-wrap items-center gap-2 rounded-lg border bg-background p-3 shadow-md">
			<span className="text-sm font-medium">Unsaved changes</span>
			<div className="ml-auto flex gap-2">
				<Button disabled={saving} onClick={onDiscard} type="button" variant="outline">
					Discard
				</Button>
				<Button disabled={saving} onClick={onSave} type="button">
					{saving ? "Saving…" : "Save changes"}
				</Button>
			</div>
		</div>
	);
}
