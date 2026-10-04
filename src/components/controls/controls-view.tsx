import { AllowlistEditor } from "#/components/controls/allowlist-editor.tsx";
import { DetectionEditor } from "#/components/controls/detection-editor.tsx";
import { GeneralForm } from "#/components/controls/general-form.tsx";
import { ProfilesEditor } from "#/components/controls/profiles-editor.tsx";
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
				Edit the safe policy subsets — general switches, detection rules, the model allowlist, and
				strictness profiles. Saving sends the full document with its base version; stale writers are
				rejected so concurrent edits never silently overwrite each other.
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
	version,
}: {
	dirty: boolean;
	onDiscard: () => void;
	onSave: () => void;
	saving: boolean;
	version: string;
}) {
	return (
		<div className="flex flex-wrap items-center gap-2">
			<Badge variant="outline">policy v{version}</Badge>
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
				<ul className="flex flex-col gap-1">
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
	draft,
	onDraftChange,
}: {
	draft: Policy;
	onDraftChange: (next: Policy) => void;
}) {
	return (
		<Tabs defaultValue="general">
			<TabsList>
				<TabsTrigger value="allowlist">Allowlist</TabsTrigger>
				<TabsTrigger value="detection">Detection</TabsTrigger>
				<TabsTrigger value="general">General</TabsTrigger>
				<TabsTrigger value="profiles">Profiles</TabsTrigger>
			</TabsList>
			<TabsContent value="allowlist">
				<AllowlistEditor draft={draft} onChange={onDraftChange} />
			</TabsContent>
			<TabsContent value="detection">
				<DetectionEditor draft={draft} onChange={onDraftChange} />
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
