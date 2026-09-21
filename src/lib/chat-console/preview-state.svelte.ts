import { getRailPreviewState, setRailPreviewState } from './preview.remote';
import { normalizePreviewUrl, type RailTab } from './preview-kinds';
import { openRight } from './mobile-drawer-state.svelte';

/**
 * #29 — right-rail preview state.
 *
 * The rail is rendered above the chat page in the layout tree, so this is the
 * same prop-drilling escape hatch `console-state.svelte.ts` uses. It is kept
 * separate because it has something that store does not: **persistence**. The
 * selection is written back to `chat_rail_preview` keyed by conversation, so
 * reopening a chat restores the tab and whatever was being looked at.
 *
 * The `proposed` field is the security-relevant part. A URL that arrives from a
 * tool result is attacker-influenced data — a page the agent fetched can put
 * any string in front of us. Those never become an iframe src on their own;
 * they land in `proposed`, the rail shows the URL, and a human click promotes
 * them. Only a URL the user typed loads directly.
 */

export type PreviewSelection =
	| { kind: 'none' }
	| { kind: 'file'; path: string }
	| { kind: 'url'; url: string };

export type ProposedUrl = {
	url: string;
	/** Where it came from, shown verbatim next to the URL ("browser_navigate", "shell"). */
	source: string;
};

export const previewState = $state({
	tab: 'Preview' as RailTab,
	selection: { kind: 'none' } as PreviewSelection,
	proposed: null as ProposedUrl | null,
	/** Previously opened file paths, for the back button. Newest last. */
	history: [] as string[],
	/** Conversation the current state belongs to; null before the first hydrate. */
	hydratedFor: null as string | null,
	hydrating: false,
});

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave() {
	const conversationId = previewState.hydratedFor;
	if (!conversationId) return;
	const snapshot = {
		conversationId,
		tab: previewState.tab,
		kind: previewState.selection.kind,
		target:
			previewState.selection.kind === 'file'
				? previewState.selection.path
				: previewState.selection.kind === 'url'
					? previewState.selection.url
					: null,
	};
	if (saveTimer) clearTimeout(saveTimer);
	saveTimer = setTimeout(() => {
		saveTimer = null;
		void setRailPreviewState(snapshot).catch(() => {
			// A failed persist must never break the panel — the selection is still
			// live in memory for this session.
		});
	}, 400);
}

/** Load the stored selection for a conversation. Idempotent per conversation id. */
export async function hydratePreviewState(conversationId: string | null) {
	if (!conversationId) {
		previewState.hydratedFor = null;
		previewState.selection = { kind: 'none' };
		previewState.proposed = null;
		previewState.history = [];
		return;
	}
	if (previewState.hydratedFor === conversationId || previewState.hydrating) return;
	previewState.hydrating = true;
	try {
		const stored = await getRailPreviewState(conversationId);
		previewState.tab = stored.tab;
		previewState.selection =
			stored.kind === 'file' && stored.target
				? { kind: 'file', path: stored.target }
				: stored.kind === 'url' && stored.target
					? { kind: 'url', url: stored.target }
					: { kind: 'none' };
		previewState.proposed = null;
		previewState.history = [];
		previewState.hydratedFor = conversationId;
	} catch {
		// No stored row / offline — fall back to an empty panel for this chat.
		previewState.selection = { kind: 'none' };
		previewState.history = [];
		previewState.hydratedFor = conversationId;
	} finally {
		previewState.hydrating = false;
	}
}

export function setRailTab(tab: RailTab) {
	previewState.tab = tab;
	scheduleSave();
}

function pushHistory() {
	if (previewState.selection.kind === 'file') {
		previewState.history = [...previewState.history.slice(-19), previewState.selection.path];
	}
}

export function openFilePreview(path: string) {
	const trimmed = path.trim();
	if (!trimmed) return;
	if (previewState.selection.kind === 'file' && previewState.selection.path === trimmed) return;
	pushHistory();
	previewState.selection = { kind: 'file', path: trimmed };
	previewState.proposed = null;
	previewState.tab = 'Preview';
	scheduleSave();
}

export function goBack() {
	const previous = previewState.history.at(-1);
	if (!previous) return;
	previewState.history = previewState.history.slice(0, -1);
	previewState.selection = { kind: 'file', path: previous };
	scheduleSave();
}

/**
 * Load a URL the *user* supplied (typed into the rail, or promoted from a
 * proposal). Rejects anything that is not http/https.
 */
export function openUrlPreview(raw: string): boolean {
	const url = normalizePreviewUrl(raw);
	if (!url) return false;
	previewState.selection = { kind: 'url', url };
	previewState.proposed = null;
	previewState.tab = 'Preview';
	scheduleSave();
	return true;
}

/**
 * Offer a URL that came out of a tool result. Deliberately does NOT load it:
 * it is shown first and needs a click. See the module comment.
 */
export function proposeUrlPreview(raw: string, source: string): boolean {
	const url = normalizePreviewUrl(raw);
	if (!url) return false;
	previewState.proposed = { url, source };
	previewState.tab = 'Preview';
	return true;
}

export function confirmProposedUrl() {
	const proposed = previewState.proposed;
	if (!proposed) return;
	openUrlPreview(proposed.url);
}

export function dismissProposedUrl() {
	previewState.proposed = null;
}

export function clearPreview() {
	previewState.selection = { kind: 'none' };
	previewState.proposed = null;
	previewState.history = [];
	scheduleSave();
}

/** Below the rail's breakpoint the rail lives in a drawer, so opening it is part of "show me this". */
export function revealRail() {
	if (typeof window !== 'undefined' && window.matchMedia('(max-width: 47.99rem)').matches) {
		openRight();
	}
}
