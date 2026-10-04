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
import { parseSemanticConfig, type SemanticConfig } from "#/control/semantic/config.ts";
import {
	getJevDocument,
	getPolicyDocument,
	updateJevDocument,
	updatePolicyDocument,
} from "#/dashboard/policy-server.ts";

interface PolicyPayload {
	policy: Policy;
	version: string;
}

interface SaveResult {
	issues: SaveIssue[];
	payload: PolicyPayload | null;
}

const LOAD_FAILED_MESSAGE = "Could not load the policy document from /api/policy.";
const JEV_LOAD_FAILED_MESSAGE = "Could not load the JEV checks from /api/jev.";
const SAVE_FAILED_MESSAGE = "Save failed without details from the server.";
const SAVE_SUCCESS_MESSAGE = "Policy saved.";
const JEV_SAVE_SUCCESS_MESSAGE = "JEV checks saved.";

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

interface JevPayload {
	config: SemanticConfig;
	version: string;
}

interface JevSaveResult {
	issues: SaveIssue[];
	payload: JevPayload | null;
}

function parseJevPayload(body: { config?: unknown; semanticVersion?: unknown }): JevPayload | null {
	try {
		const config = parseSemanticConfig(body.config);
		const rawVersion = body.semanticVersion;
		const version =
			typeof rawVersion === "string" && rawVersion.length > 0
				? rawVersion
				: JSON.stringify(config.checks.length);
		return { config: { ...config, checks: [...config.checks] }, version };
	} catch {
		return null;
	}
}

async function loadJev(): Promise<JevPayload | null> {
	try {
		const document = await getJevDocument();
		const payload = parseJevPayload({
			config: document.config,
			semanticVersion: document.semanticVersion,
		});
		if (payload !== null) {
			return payload;
		}
		return { config: document.config, version: document.semanticVersion };
	} catch {
		return null;
	}
}

async function postJev(config: SemanticConfig, baseVersion: string): Promise<JevSaveResult> {
	try {
		const result = await updateJevDocument({ data: { baseVersion, config } });
		if (!result.ok) {
			return { issues: parseIssues(result.issues), payload: null };
		}
		const payload = parseJevPayload({
			config: result.config,
			semanticVersion: result.semanticVersion,
		});
		if (payload === null) {
			return { issues: [{ message: SAVE_FAILED_MESSAGE, path: "" }], payload: null };
		}
		return { issues: [], payload };
	} catch {
		return { issues: [{ message: SAVE_FAILED_MESSAGE, path: "" }], payload: null };
	}
}

interface JevEditorState {
	dirty: boolean;
	draft: SemanticConfig | null;
	handleDiscard: () => void;
	handleJevChange: (next: SemanticConfig) => void;
	handleSave: () => void;
	issues: readonly SaveIssue[];
	jevLoadError: string | null;
	notice: string | null;
	onRetry: () => void;
	saved: JevPayload | null;
	saving: boolean;
}

interface JevLoaderState {
	draft: SemanticConfig | null;
	jevLoadError: string | null;
	onRetry: () => void;
	saved: JevPayload | null;
	setDraft: (next: SemanticConfig | null) => void;
	setSaved: (next: JevPayload | null) => void;
}

function useJevLoader(): JevLoaderState {
	const liveRef = useRef(true);
	const [draft, setDraft] = useState<SemanticConfig | null>(null);
	const [saved, setSaved] = useState<JevPayload | null>(null);
	const [jevLoadError, setJevLoadError] = useState<string | null>(null);
	useEffect(
		() => () => {
			liveRef.current = false;
		},
		[],
	);
	const reload = useCallback((): void => {
		loadJev()
			.then((payload) => {
				if (!liveRef.current) {
					return;
				}
				if (payload === null) {
					setJevLoadError(JEV_LOAD_FAILED_MESSAGE);
					return;
				}
				setJevLoadError(null);
				setSaved(payload);
				setDraft(structuredClone(payload.config));
			})
			.catch(() => {
				if (liveRef.current) {
					setJevLoadError(JEV_LOAD_FAILED_MESSAGE);
				}
			});
	}, []);
	useEffect(() => {
		reload();
	}, [reload]);
	return { draft, jevLoadError, onRetry: reload, saved, setDraft, setSaved };
}

function submitJev(
	draft: SemanticConfig,
	saved: JevPayload,
	controls: {
		onSettled: () => void;
		setDraft: (next: SemanticConfig) => void;
		setIssues: (next: readonly SaveIssue[]) => void;
		setNotice: (next: string | null) => void;
		setSaved: (next: JevPayload) => void;
	},
): void {
	postJev(draft, saved.version)
		.then((result) => {
			if (result.payload === null) {
				controls.setIssues(result.issues);
				controls.setNotice(result.issues.length === 0 ? SAVE_FAILED_MESSAGE : null);
				return;
			}
			controls.setSaved(result.payload);
			controls.setDraft(structuredClone(result.payload.config));
			controls.setIssues([]);
			controls.setNotice(JEV_SAVE_SUCCESS_MESSAGE);
		})
		.catch(() => {
			controls.setIssues([]);
			controls.setNotice(SAVE_FAILED_MESSAGE);
		})
		.finally(() => {
			controls.onSettled();
		});
}

function useJevEditor(): JevEditorState {
	const { draft, jevLoadError, onRetry, saved, setDraft, setSaved } = useJevLoader();
	const [issues, setIssues] = useState<readonly SaveIssue[]>([]);
	const [notice, setNotice] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const dirty =
		saved !== null && draft !== null && JSON.stringify(draft) !== JSON.stringify(saved.config);
	const handleJevChange = (next: SemanticConfig): void => {
		setDraft(next);
		setIssues([]);
		setNotice(null);
	};
	const handleDiscard = (): void => {
		if (saved === null) {
			return;
		}
		setDraft(structuredClone(saved.config));
		setIssues([]);
		setNotice(null);
	};
	const handleSave = (): void => {
		if (saved === null || draft === null || saving) {
			return;
		}
		setSaving(true);
		setNotice(null);
		submitJev(draft, saved, {
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
		handleJevChange,
		handleSave,
		issues,
		jevLoadError,
		notice,
		onRetry,
		saved,
		saving,
	};
}

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
	const jev = useJevEditor();
	if (editor.saved === null || editor.draft === null) {
		return (
			<main className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
				<PageHeader />
				<LoadingView error={editor.loadError} onRetry={editor.onRetry} />
			</main>
		);
	}
	const dirty = editor.dirty || jev.dirty;
	const saving = editor.saving || jev.saving;
	const handleDiscard = (): void => {
		editor.handleDiscard();
		jev.handleDiscard();
	};
	const handleSave = (): void => {
		if (editor.dirty) {
			editor.handleSave();
		}
		if (jev.dirty) {
			jev.handleSave();
		}
	};
	const notice = [editor.notice, jev.notice].find((entry) => entry !== null) ?? null;
	const issues = [...editor.issues, ...jev.issues];
	const jevDraft = jev.draft ?? undefined;
	return (
		<main className="mx-auto flex max-w-5xl flex-col gap-6 p-8">
			<PageHeader />
			<StatusBar
				dirty={dirty}
				onDiscard={handleDiscard}
				onSave={handleSave}
				saving={saving}
				version={editor.saved.version}
			/>
			<Separator />
			{notice !== null ? <output className="text-muted-foreground text-sm">{notice}</output> : null}
			{jev.jevLoadError !== null ? (
				<output className="text-muted-foreground text-sm">
					{jev.jevLoadError}{" "}
					<button onClick={jev.onRetry} type="button">
						Retry
					</button>
				</output>
			) : null}
			<IssuesCard issues={issues} />
			<EditorTabs
				draft={editor.draft}
				jevDraft={jevDraft}
				onDraftChange={editor.handleDraftChange}
				onJevChange={jev.draft === null ? undefined : jev.handleJevChange}
			/>
			<StickyBar dirty={dirty} onDiscard={handleDiscard} onSave={handleSave} saving={saving} />
		</main>
	);
}
