<script lang="ts">
	/**
	 * #18 — the actions for one conversation in the sidebar list.
	 *
	 * Archive is the primary lifecycle action: it is the one-click button on the row (on a
	 * pointer device) and the first item in the menu, because it tidies the list without
	 * losing anything. Delete is last, behind a confirmation, because it cannot be undone.
	 *
	 * The menu opens inline under the row rather than as a floating popover, so the
	 * scrolling chat list and the phone drawer never clip it. On a touch screen the "⋯" button
	 * is always shown; on a pointer device it appears on hover or focus.
	 */
	import { tick } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		deleteConversation,
		getArchivedConversations,
		getConversation,
		getConversations,
		setConversationArchived,
		setConversationPinned,
		updateConversationMeta,
	} from '$lib/chat';
	import { confirmDialog } from '$lib/ui/confirm-dialog.svelte';
	import { remoteErrorMessage } from '$lib/ui/remote-error';
	import Icon from './Icon.svelte';

	type RowConversation = {
		id: string;
		title: string;
		pinnedAt: Date | string | null;
		archivedAt: Date | string | null;
	};

	let {
		conversation,
		active = false,
		onChanged,
		onNavigate,
	}: {
		conversation: RowConversation;
		/** This is the conversation open on screen. */
		active?: boolean;
		/** After any change, so the list can re-run a search that may include this chat. */
		onChanged?: () => void;
		/** Called before leaving the page (after deleting the open chat) — closes the phone drawer. */
		onNavigate?: () => void;
	} = $props();

	let open = $state(false);
	let renaming = $state(false);
	let draftTitle = $state('');
	let busy = $state(false);
	let errorMessage = $state<string | null>(null);
	let actionsEl = $state<HTMLDivElement | null>(null);
	let menuEl = $state<HTMLDivElement | null>(null);
	let renameInput = $state<HTMLInputElement | null>(null);

	const pinned = $derived(conversation.pinnedAt !== null);
	const archived = $derived(conversation.archivedAt !== null);
	const exportBase = $derived(`/chat/${conversation.id}/export`);

	function close() {
		open = false;
		renaming = false;
		errorMessage = null;
	}

	function toggle() {
		if (open) close();
		else {
			open = true;
			errorMessage = null;
		}
	}

	/** The archive is refetched only when this chat is in it, or is going into it: nothing else moves it. */
	async function refreshLists(archiveToo: boolean) {
		await Promise.all([
			getConversations().refresh().catch(() => {}),
			archiveToo ? getArchivedConversations().refresh().catch(() => {}) : null,
		]);
		onChanged?.();
	}

	async function run(action: () => Promise<unknown>, fallback: string, touchesArchive = archived): Promise<boolean> {
		if (busy) return false;
		busy = true;
		errorMessage = null;
		try {
			await action();
			await refreshLists(touchesArchive);
			return true;
		} catch (err) {
			errorMessage = remoteErrorMessage(err, fallback);
			open = true;
			return false;
		} finally {
			busy = false;
		}
	}

	async function toggleArchived() {
		const done = await run(
			() => setConversationArchived({ id: conversation.id, archived: !archived }),
			archived ? 'Could not unarchive this chat.' : 'Could not archive this chat.',
			true,
		);
		if (done) close();
	}

	async function togglePinned() {
		const done = await run(
			() => setConversationPinned({ id: conversation.id, pinned: !pinned }),
			pinned ? 'Could not unpin this chat.' : 'Could not pin this chat.',
		);
		if (done) close();
	}

	async function startRename() {
		draftTitle = conversation.title;
		renaming = true;
		errorMessage = null;
		await tick();
		renameInput?.focus();
		renameInput?.select();
	}

	async function saveRename(event?: SubmitEvent) {
		event?.preventDefault();
		const title = draftTitle.trim();
		if (!title || title === conversation.title) {
			close();
			return;
		}
		const done = await run(async () => {
			await updateConversationMeta({ id: conversation.id, title: title.slice(0, 120) });
			if (active) await getConversation(conversation.id).refresh();
		}, 'Could not rename this chat.');
		if (done) close();
	}

	async function remove() {
		const confirmed = await confirmDialog({
			title: 'Delete this conversation?',
			message:
				'Its messages and run history are removed for good, and memories mined from it lose their link back to it. Cost records are kept. To tidy the list without losing anything, archive it instead.',
			confirmLabel: 'Delete',
			variant: 'danger',
		});
		if (!confirmed) return;
		const done = await run(() => deleteConversation(conversation.id), 'Could not delete this chat.');
		if (!done) return;
		close();
		if (active) {
			onNavigate?.();
			await goto('/');
		}
	}

	/**
	 * A download link closes the menu only after the click has done its work: removing the
	 * link during its own click cancels the download (a disconnected link cannot navigate).
	 */
	function closeAfterClick() {
		setTimeout(close, 0);
	}

	// A press anywhere else closes the menu. Listened for only while open: the list has a
	// menu per row, and a window listener each would be hundreds of idle handlers.
	$effect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (!target || actionsEl?.contains(target) || menuEl?.contains(target)) return;
			close();
		};
		window.addEventListener('pointerdown', onPointerDown);
		return () => window.removeEventListener('pointerdown', onPointerDown);
	});

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && open) {
			event.stopPropagation();
			close();
		}
	}
</script>

<!-- Escape on the "⋯" button closes the menu too, before the drawer hears it. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="console-rowactions {open ? 'is-open' : ''}" bind:this={actionsEl} onkeydown={handleKeydown}>
	<button
		type="button"
		class="console-rowactions__btn console-rowactions__quick"
		title={archived ? 'Unarchive' : 'Archive'}
		aria-label={`${archived ? 'Unarchive' : 'Archive'} ${conversation.title}`}
		disabled={busy}
		onclick={toggleArchived}
	>
		<Icon name="archive" size={13} />
	</button>
	<button
		type="button"
		class="console-rowactions__btn"
		title="Conversation actions"
		aria-label={`Actions for ${conversation.title}`}
		aria-haspopup="menu"
		aria-expanded={open}
		onclick={toggle}
	>
		<Icon name="dots" size={13} />
	</button>
</div>

{#if open}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="console-rowmenu"
		role={renaming ? undefined : 'menu'}
		aria-label={`Actions for ${conversation.title}`}
		bind:this={menuEl}
		onkeydown={handleKeydown}
	>
		{#if renaming}
			<form class="console-rowmenu__rename" onsubmit={saveRename}>
				<input
					bind:this={renameInput}
					bind:value={draftTitle}
					type="text"
					maxlength="120"
					aria-label="Conversation title"
					disabled={busy}
				/>
				<div class="console-rowmenu__renamebtns">
					<button type="button" class="console-rowmenu__item" onclick={close} disabled={busy}>Cancel</button>
					<button type="submit" class="console-rowmenu__item is-primary" disabled={busy || !draftTitle.trim()}>Save</button>
				</div>
			</form>
		{:else}
			<button type="button" role="menuitem" class="console-rowmenu__item is-primary" disabled={busy} onclick={toggleArchived}>
				<Icon name="archive" size={13} />
				<span>{archived ? 'Unarchive' : 'Archive'}</span>
			</button>
			<button type="button" role="menuitem" class="console-rowmenu__item" disabled={busy} onclick={togglePinned}>
				<Icon name="pin" size={13} />
				<span>{pinned ? 'Unpin' : 'Pin to top'}</span>
			</button>
			<button type="button" role="menuitem" class="console-rowmenu__item" disabled={busy} onclick={startRename}>
				<Icon name="edit" size={13} />
				<span>Rename</span>
			</button>
			<a role="menuitem" class="console-rowmenu__item" href={`${exportBase}?format=md`} download onclick={closeAfterClick}>
				<Icon name="download" size={13} />
				<span>Export as Markdown</span>
			</a>
			<a role="menuitem" class="console-rowmenu__item" href={`${exportBase}?format=json`} download onclick={closeAfterClick}>
				<Icon name="download" size={13} />
				<span>Export as JSON</span>
			</a>
			<div class="console-rowmenu__sep" role="separator"></div>
			<button type="button" role="menuitem" class="console-rowmenu__item is-danger" disabled={busy} onclick={remove}>
				<Icon name="trash" size={13} />
				<span>Delete…</span>
			</button>
		{/if}
		{#if errorMessage}
			<p class="console-rowmenu__error" role="alert">{errorMessage}</p>
		{/if}
	</div>
{/if}
