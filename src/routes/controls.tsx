import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	EditorTabs,
	IssuesCard,
	LoadingView,
	PageHeader,
	type SaveIssue,
	StatusBar,
	StickyBar,
} from "#/components/controls/controls-view.tsx";
import { Separator } from "#/components/ui/separator.tsx";
import { type Policy, policySchema } from "#/control/policy/schema.ts";
import { getPolicyDocument, updatePolicyDocument } from "#/dashboard/policy-server.ts";

interface PolicyPayload {
	policy: Policy;
	version: string;
}

interface SaveResult {
	issues: SaveIssue[];
	payload: PolicyPayload | null;
}

const LOAD_FAILED_MESSAGE = "Could not load the policy document from /api/policy.";
const SAVE_FAILED_MESSAGE = "Save failed without details from the server.";
const SAVE_SUCCESS_MESSAGE = "Policy saved.";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

interface PolicyPayloadBody {
	policy?: unknown;
	policyVersion?: unknown;
}

interface IssueBody {
	message?: unknown;
	path?: unknown;
}

function parsePolicyPayload(body: unknown): PolicyPayload | null {
	if (!isRecord(body)) {
		return null;
	}
	const shaped: PolicyPayloadBody = body;
	const parsed = policySchema.safeParse(shaped.policy);
	if (!parsed.success) {
		return null;
	}
	const rawVersion = shaped.policyVersion;
	const version =
		typeof rawVersion === "string" && rawVersion.length > 0 ? rawVersion : parsed.data.version;
	return { policy: parsed.data, version };
}

function asSaveIssue(value: unknown): SaveIssue | null {
	if (!isRecord(value)) {
		return null;
	}
	const shaped: IssueBody = value;
	const { message } = shaped;
	if (typeof message !== "string") {
		return null;
	}
	const { path: rawPath } = shaped;
	const path = Array.isArray(rawPath) ? rawPath.map((part) => String(part)).join(".") : "";
	return { message, path };
}

function parseIssues(value: unknown): SaveIssue[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const issues: SaveIssue[] = [];
	for (const entry of value) {
		const issue = asSaveIssue(entry);
		if (issue !== null) {
			issues.push(issue);
		}
	}
	return issues;
}

async function loadPolicy(): Promise<PolicyPayload | null> {
	try {
		const document = await getPolicyDocument();
		const payload = parsePolicyPayload({
			policy: document.policy,
			policyVersion: document.policyVersion,
		});
		if (payload !== null) {
			return payload;
		}
		return { policy: document.policy, version: document.policyVersion };
	} catch {
		return null;
	}
}

async function postPolicy(policy: Policy, baseVersion: string): Promise<SaveResult> {
	try {
		const result = await updatePolicyDocument({ data: { baseVersion, policy } });
		if (!result.ok) {
			return { issues: parseIssues(result.issues), payload: null };
		}
		const payload = parsePolicyPayload({
			policy: result.policy,
			policyVersion: result.policyVersion,
		});
		if (payload === null) {
			return { issues: [{ message: SAVE_FAILED_MESSAGE, path: "" }], payload: null };
		}
		return { issues: [], payload };
	} catch {
		return { issues: [{ message: SAVE_FAILED_MESSAGE, path: "" }], payload: null };
	}
}

export const Route = createFileRoute("/controls")({
	component: ControlsPage,
	loader: loadPolicy,
});

interface PolicyLoaderState {
	draft: Policy | null;
	loadError: string | null;
	onRetry: () => void;
	saved: PolicyPayload | null;
	setDraft: (next: Policy | null) => void;
	setSaved: (next: PolicyPayload | null) => void;
}

function usePolicyLoader(initial: PolicyPayload | null | undefined): PolicyLoaderState {
	const liveRef = useRef(true);
	const seed: PolicyPayload | null = initial ?? null;
	const [draft, setDraft] = useState<Policy | null>(() =>
		seed === null ? null : structuredClone(seed.policy),
	);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [saved, setSaved] = useState<PolicyPayload | null>(seed);
	useEffect(
		() => () => {
			liveRef.current = false;
		},
		[],
	);
	const reload = useCallback((): void => {
		loadPolicy()
			.then((payload) => {
				if (!liveRef.current) {
					return;
				}
				if (payload === null) {
					setLoadError(LOAD_FAILED_MESSAGE);
					return;
				}
				setLoadError(null);
				setSaved(payload);
				setDraft(structuredClone(payload.policy));
			})
			.catch(() => {
				if (liveRef.current) {
					setLoadError(LOAD_FAILED_MESSAGE);
				}
			});
	}, []);
	useEffect(() => {
		if (initial === null) {
			reload();
		}
	}, [initial, reload]);
	return { draft, loadError, onRetry: reload, saved, setDraft, setSaved };
}

interface PolicyEditorState {
	dirty: boolean;
	draft: Policy | null;
	handleDiscard: () => void;
	handleDraftChange: (next: Policy) => void;
	handleSave: () => void;
	issues: readonly SaveIssue[];
	loadError: string | null;
	notice: string | null;
	onRetry: () => void;
	saved: PolicyPayload | null;
	saving: boolean;
}

function submitPolicy(
	draft: Policy,
	saved: PolicyPayload,
	controls: {
		onSettled: () => void;
		setDraft: (next: Policy) => void;
		setIssues: (next: readonly SaveIssue[]) => void;
		setNotice: (next: string | null) => void;
		setSaved: (next: PolicyPayload) => void;
	},
): void {
	postPolicy(draft, saved.version)
		.then((result) => {
			if (result.payload === null) {
				controls.setIssues(result.issues);
				controls.setNotice(result.issues.length === 0 ? SAVE_FAILED_MESSAGE : null);
				return;
			}
			controls.setSaved(result.payload);
			controls.setDraft(structuredClone(result.payload.policy));
			controls.setIssues([]);
			controls.setNotice(SAVE_SUCCESS_MESSAGE);
		})
		.catch(() => {
			controls.setIssues([]);
			controls.setNotice(SAVE_FAILED_MESSAGE);
		})
		.finally(() => {
			controls.onSettled();
		});
}

function usePolicyEditor(initial: PolicyPayload | null | undefined): PolicyEditorState {
	const normalized = initial ?? null;
	const { draft, loadError, onRetry, saved, setDraft, setSaved } = usePolicyLoader(normalized);
	const [issues, setIssues] = useState<readonly SaveIssue[]>([]);
	const [notice, setNotice] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const dirty =
		saved !== null && draft !== null && JSON.stringify(draft) !== JSON.stringify(saved.policy);
	const handleDraftChange = (next: Policy): void => {
		setDraft(next);
		setIssues([]);
		setNotice(null);
	};
	const handleDiscard = (): void => {
		if (saved === null) {
			return;
		}
		setDraft(structuredClone(saved.policy));
		setIssues([]);
		setNotice(null);
	};
	const handleSave = (): void => {
		if (saved === null || draft === null || saving) {
			return;
		}
		setSaving(true);
		setNotice(null);
		submitPolicy(draft, saved, {
			onSettled: () => setSaving(false),
			setDraft,
			setIssues,
			setNotice,
			setSaved,
		});
	};
	return {
		dirty,
		draft,
		handleDiscard,
		handleDraftChange,
		handleSave,
		issues,
		loadError,
		notice,
		onRetry,
		saved,
		saving,
	};
}

function ControlsPage() {
	const initial = Route.useLoaderData();
	const editor = usePolicyEditor(initial);
	if (editor.saved === null || editor.draft === null) {
		return (
			<main className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
				<PageHeader />
				<LoadingView error={editor.loadError} onRetry={editor.onRetry} />
			</main>
		);
	}
	return (
		<main className="mx-auto flex max-w-5xl flex-col gap-6 p-8">
			<PageHeader />
			<StatusBar
				dirty={editor.dirty}
				onDiscard={editor.handleDiscard}
				onSave={editor.handleSave}
				saving={editor.saving}
				version={editor.saved.version}
			/>
			<Separator />
			{editor.notice !== null ? (
				<output className="text-muted-foreground text-sm">{editor.notice}</output>
			) : null}
			<IssuesCard issues={editor.issues} />
			<EditorTabs draft={editor.draft} onDraftChange={editor.handleDraftChange} />
			<StickyBar
				dirty={editor.dirty}
				onDiscard={editor.handleDiscard}
				onSave={editor.handleSave}
				saving={editor.saving}
			/>
		</main>
	);
}
