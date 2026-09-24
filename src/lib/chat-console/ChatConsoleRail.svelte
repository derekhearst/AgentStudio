<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import Icon from './Icon.svelte';
	import PreviewPane from './PreviewPane.svelte';
	import { consoleState } from './console-state.svelte';
	import {
		collapseRail,
		expandRail,
		hydratePreviewState,
		hydrateRailOpen,
		openFilePreview,
		previewState,
		setRailTab,
	} from './preview-state.svelte';
	import { RAIL_TABS, type RailTab } from './preview-kinds';

	/*
	 * #14 — two tabs, folded away until there is something to show.
	 *
	 * The rail used to carry four tabs (Preview, Research, Files, Activity) and a stats
	 * footer, and most of the time all of it was empty or repeated the thread. What is left
	 * is the one job it does well — showing a file or a page beside the conversation — and
	 * Files, which now lists what the agent actually changed in this chat. On the desktop
	 * column it starts as a thin strip and expands when something opens a preview, when a
	 * strip button is clicked, or when the viewer left it expanded last time.
	 *
	 * `variant="drawer"` is the phone's slide-in copy. The drawer is opened and closed by
	 * hand, so it always shows the full rail and has no collapse control; tapping a tab or a
	 * file in it leaves the column's remembered fold alone (see `setOpen` in preview-state).
	 */
	let { variant = 'column' }: { variant?: 'column' | 'drawer' } = $props();

	const activeTab = $derived(previewState.tab);
	const conversationId = $derived(consoleState.conversationId);
	const changedFiles = $derived(consoleState.changedFiles);
	const collapsed = $derived(variant === 'column' && !previewState.open);
	const hasPreview = $derived(previewState.selection.kind !== 'none' || previewState.proposed !== null);

	// Restore what this chat was last looking at. `untrack` so the store writes
	// hydration performs don't feed back into this effect.
	$effect(() => {
		const id = conversationId;
		untrack(() => void hydratePreviewState(id));
	});

	onMount(() => void hydrateRailOpen());

	/*
	 * Folding and expanding swap the strip for the full rail, which removes the button that
	 * was just pressed and would drop keyboard focus to the page. After each of the rail's
	 * own controls, focus moves to the control that now stands where it was: expanding lands
	 * on the tab that was asked for (or the collapse button), folding lands on the expand
	 * button. The same goes for the Files list and the preview bar, which a click in them
	 * removes. Nothing moves when focus is still somewhere, such as on a button that stayed.
	 */
	let expandButton = $state<HTMLButtonElement | null>(null);
	let collapseButton = $state<HTMLButtonElement | null>(null);
	const tabButtons = $state<Partial<Record<RailTab, HTMLButtonElement | null>>>({});

	async function refocus(target: () => HTMLElement | null | undefined) {
		await tick();
		const active = document.activeElement;
		if (active && active !== document.body) return;
		target()?.focus();
	}

	function expandFromStrip() {
		expandRail();
		void refocus(() => collapseButton);
	}

	function showTabFromStrip(tab: RailTab) {
		setRailTab(tab);
		void refocus(() => tabButtons[tab] ?? collapseButton);
	}

	function collapseFromTabs() {
		collapseRail();
		void refocus(() => expandButton);
	}

	/** Opening a file from Files switches to Preview, which removes the Files list. */
	function openFromFiles(path: string) {
		openFilePreview(path);
		void refocus(() => tabButtons.Preview);
	}

	/** Closing the preview removes its bar, and on the column folds the rail too. */
	function afterPreviewClosed() {
		void refocus(() => (collapsed ? expandButton : tabButtons.Preview));
	}
</script>

{#if collapsed}
	<aside class="console-rail is-collapsed" aria-label="Chat rail">
		<button
			type="button"
			class="console-rail__strip-btn"
			title="Expand rail"
			aria-label="Expand rail"
			bind:this={expandButton}
			onclick={expandFromStrip}
		>
			<Icon name="panel" size={15} />
		</button>
		<button
			type="button"
			class="console-rail__strip-btn"
			title={hasPreview ? 'Preview — something is open' : 'Preview'}
			aria-label="Show Preview"
			onclick={() => showTabFromStrip('Preview')}
		>
			<Icon name="search" size={15} />
			{#if hasPreview}<span class="console-rail__strip-dot" aria-hidden="true"></span>{/if}
		</button>
		<button
			type="button"
			class="console-rail__strip-btn"
			title={changedFiles.length > 0 ? `Files — ${changedFiles.length} changed in this chat` : 'Files'}
			aria-label="Show Files"
			onclick={() => showTabFromStrip('Files')}
		>
			<Icon name="file" size={15} />
			{#if changedFiles.length > 0}
				<span class="console-rail__strip-ct" data-testid="rail-files-count">{changedFiles.length}</span>
			{/if}
		</button>
	</aside>
{:else}
	<aside class="console-rail {variant === 'drawer' ? 'is-drawer' : ''}" aria-label="Chat rail">
		<div class="console-rail__tabs">
			<div class="console-rail__tablist" role="tablist" aria-label="Rail tabs">
				{#each RAIL_TABS as tab (tab)}
					<button
						type="button"
						role="tab"
						aria-selected={activeTab === tab}
						class="console-rail__tab {activeTab === tab ? 'active' : ''}"
						bind:this={tabButtons[tab]}
						onclick={() => setRailTab(tab)}
					>
						{tab}
						{#if tab === 'Files' && changedFiles.length > 0}
							<span class="ct">{changedFiles.length}</span>
						{/if}
					</button>
				{/each}
			</div>
			{#if variant === 'column'}
				<button
					type="button"
					class="console-rail__collapse"
					title="Collapse rail"
					aria-label="Collapse rail"
					bind:this={collapseButton}
					onclick={collapseFromTabs}
				>
					<Icon name="panel" size={14} />
				</button>
			{/if}
		</div>

		<div class="console-rail__body {activeTab === 'Preview' ? 'is-preview' : ''}">
			{#if activeTab === 'Preview'}
				<PreviewPane {conversationId} onClosed={afterPreviewClosed} />
			{:else}
				<div class="console-rail__sec">
					<div class="lbl">
						<span>Changed in this chat</span>
						{#if changedFiles.length > 0}<span class="meta">{changedFiles.length} {changedFiles.length === 1 ? 'file' : 'files'}</span>{/if}
					</div>
				</div>
				{#if changedFiles.length === 0}
					<div class="console-rail__empty">No files changed in this chat yet.</div>
				{:else}
					<ul class="console-files">
						{#each changedFiles as file (file.path)}
							<li>
								<button type="button" class="console-files__row" title={`Preview ${file.path}`} onclick={() => openFromFiles(file.path)}>
									<Icon name="file" size={12} />
									<span class="console-files__path">
										<span class="console-files__name">{file.name}</span>
										{#if file.dir}<span class="console-files__dir">{file.dir}</span>{/if}
									</span>
									{#if file.changeType === 'create'}<span class="console-files__new">new</span>{/if}
									{#if file.additions > 0}<span class="console-files__stat is-add">+{file.additions}</span>{/if}
									{#if file.deletions > 0}<span class="console-files__stat is-del">−{file.deletions}</span>{/if}
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			{/if}
		</div>
	</aside>
{/if}
