import { browser } from '$app/environment';
import { getRailOpen, getRailPreviewState, setRailOpen, setRailPreviewState } from './preview.remote';
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
 * #14 added `open`: the rail is folded to a thin strip until something opens a
 * preview or the viewer expands it. That one is remembered per viewer, not per
 * chat (`getRailOpen` / `setRailOpen`), and belongs to the column beside the
 * thread. The phone drawer is opened and closed by hand and always shows the
 * whole rail, so nothing done on a phone-width screen changes it (see `setOpen`).
 * This browser keeps a copy of it too, read before the first render — see
 * `RAIL_OPEN_MIRROR_KEY`.
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

/**
 * #14 — this browser's copy of the viewer's fold.
 *
 * The stored preference only arrives after the page has mounted, so a viewer who left the
 * rail expanded used to get the 40px strip first and then a ~320px jump of the thread on
 * every full load. Reading this copy before the client's first render gives them the
 * expanded rail straight away, the way the rail's width (`console:rail-w`) already works.
 * The database row stays the source of truth: `hydrateRailOpen` overwrites both once it
 * loads, so a change made on another device still wins.
 *
 * Declared above `previewState` on purpose — its initialiser reads it.
 */
const RAIL_OPEN_MIRROR_KEY = 'console:rail-open';

function readRailOpenMirror(): boolean {
	if (!browser) return false;
	try {
		return localStorage.getItem(RAIL_OPEN_MIRROR_KEY) === '1';
	} catch {
		return false; // storage blocked (private window, disabled site data): start folded
	}
}

function writeRailOpenMirror(open: boolean) {
	if (!browser) return;
	try {
		localStorage.setItem(RAIL_OPEN_MIRROR_KEY, open ? '1' : '0');
	} catch {
		/* the database copy still holds it */
	}
}

export const previewState = $state({
	tab: 'Preview' as RailTab,
	selection: { kind: 'none' } as PreviewSelection,
	proposed: null as ProposedUrl | null,
	/** Previously opened file paths, for the back button. Newest last. */
	history: [] as string[],
	/** Conversation the current state belongs to; null before the first hydrate. */
	hydratedFor: null as string | null,
	/** #14 — the desktop rail is expanded (true) or folded to its strip (false). */
	open: readRailOpenMirror(),
});

/**
 * The conversation a hydrate is in flight for. Module-level rather than a boolean on the
 * store: a boolean made a hydrate for chat B return early while chat A's was still loading,
 * so B kept showing A's file and later saves went to A's row.
 */
let pendingFor: string | null = null;

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
		pendingFor = null;
		previewState.hydratedFor = null;
		previewState.selection = { kind: 'none' };
		previewState.proposed = null;
		previewState.history = [];
		return;
	}
	if (previewState.hydratedFor === conversationId || pendingFor === conversationId) return;
	pendingFor = conversationId;
	// Nothing belongs to this chat until its row arrives: don't show the previous chat's
	// file under it, and don't let a save in the meantime land on the previous chat's row.
	if (previewState.hydratedFor !== null) {
		previewState.hydratedFor = null;
		previewState.selection = { kind: 'none' };
		previewState.proposed = null;
		previewState.history = [];
	}
	try {
		const stored = await getRailPreviewState(conversationId);
		if (pendingFor !== conversationId) return; // another chat opened meanwhile
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
		if (pendingFor !== conversationId) return;
		// No stored row / offline — fall back to an empty panel for this chat.
		previewState.selection = { kind: 'none' };
		previewState.history = [];
		previewState.hydratedFor = conversationId;
	} finally {
		if (pendingFor === conversationId) pendingFor = null;
	}
}

// ── #14: expanded / collapsed, per viewer ───────────────────────────────────

let openLoaded = false;
/** Set once anything changes `open`; a stored value arriving later must not undo it. */
let openTouched = false;
let openSaveTimer: ReturnType<typeof setTimeout> | null = null;

/** Load the viewer's remembered fold once per page load. Later chats reuse it from memory. */
export async function hydrateRailOpen() {
	if (openLoaded) return;
	openLoaded = true;
	try {
		const stored = await getRailOpen();
		if (!openTouched) {
			previewState.open = stored;
			writeRailOpenMirror(stored);
		}
	} catch {
		openLoaded = false; // try again the next time the rail mounts; keep this browser's copy meanwhile
	}
}

/**
 * Expand or fold the column, and remember it for this viewer.
 *
 * Every rail action funnels through here — tab buttons, "Open file" on an edit card, a
 * Files row, "Close preview" — whichever copy of the rail they come from. On a phone-width
 * screen they all come from the drawer or the thread beside it, where the column is not
 * shown, so the fold is left alone rather than persisted: otherwise tapping Files in the
 * drawer would rewrite the preference the viewer's desktop uses.
 */
function setOpen(open: boolean) {
	if (isDrawerViewport()) return;
	openTouched = true;
	if (previewState.open === open) return;
	previewState.open = open;
	writeRailOpenMirror(open);
	if (openSaveTimer) clearTimeout(openSaveTimer);
	openSaveTimer = setTimeout(() => {
		openSaveTimer = null;
		void setRailOpen(previewState.open).catch(() => {
			// Same as the selection: the fold still holds for this session.
		});
	}, 400);
}

export function expandRail() {
	setOpen(true);
}

export function collapseRail() {
	setOpen(false);
}

export function toggleRail() {
	setOpen(!previewState.open);
}

/** Switching tab is asking to see it, so a collapsed rail expands onto that tab. */
export function setRailTab(tab: RailTab) {
	previewState.tab = tab;
	setOpen(true);
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
	// Before the same-file check: "Open file" on the file already open must still bring
	// the Preview tab (and a collapsed rail) back into view.
	const tabChanged = previewState.tab !== 'Preview';
	previewState.tab = 'Preview';
	setOpen(true);
	if (previewState.selection.kind === 'file' && previewState.selection.path === trimmed) {
		if (tabChanged) scheduleSave();
		return;
	}
	pushHistory();
	previewState.selection = { kind: 'file', path: trimmed };
	previewState.proposed = null;
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
	setOpen(true);
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
	setOpen(true);
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

/** Closing the preview leaves nothing to show, so the rail folds back to its strip. */
export function clearPreview() {
	previewState.selection = { kind: 'none' };
	previewState.proposed = null;
	previewState.history = [];
	setOpen(false);
	scheduleSave();
}

/** Below the tablet breakpoint the rail is not a column but a drawer. */
function isDrawerViewport() {
	return typeof window !== 'undefined' && window.matchMedia('(max-width: 47.99rem)').matches;
}

/** Below the rail's breakpoint the rail lives in a drawer, so opening it is part of "show me this". */
export function revealRail() {
	if (isDrawerViewport()) openRight();
}

/**
 * The chat header's rail button, shown below the desktop breakpoint: on a phone it opens the
 * drawer; on a tablet, where the rail is a column beside the thread, it expands or folds it.
 */
export function toggleRailFromHeader() {
	if (isDrawerViewport()) openRight();
	else toggleRail();
}
