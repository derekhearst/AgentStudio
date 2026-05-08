<script lang="ts">
	import { onMount } from 'svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import {
		listMemoryWingsQuery,
		listMemoryWingEdgesQuery,
		getMemoryStatsQuery,
		getMemoryDrawerQuery,
		deleteMemoryDrawerCommand,
		mineAllPendingCommand,
		type MemoryWingRow,
		type MemoryWingEdge,
		type MemoryStats,
		type MemoryDrawerDetail,
	} from '$lib/memory/memory.remote';
	import MemoryMap from '$lib/memory/MemoryMap.svelte';
	import WingDetailPanel from '$lib/memory/WingDetailPanel.svelte';
	import DrawerDetailPanel from '$lib/memory/DrawerDetailPanel.svelte';
	import SearchOverlay from '$lib/memory/SearchOverlay.svelte';
	import WingList from '$lib/memory/WingList.svelte';
	import ReorganizePanel from '$lib/memory/ReorganizePanel.svelte';

	let wings = $state<MemoryWingRow[]>([]);
	let edges = $state<MemoryWingEdge[]>([]);
	let stats = $state<MemoryStats | null>(null);
	let loading = $state(true);

	let selectedWingId = $state<string | null>(null);
	let selectedDrawerId = $state<string | null>(null);
	let drawerDetail = $state<MemoryDrawerDetail | null>(null);
	let viewMode = $state<'map' | 'list'>('map');
	let mining = $state(false);
	let mineResult = $state<{ conversationsScanned: number; enqueued: number } | null>(null);
	let showHowItWorks = $state(false);
	let showReorganize = $state(false);
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	const selectedWing = $derived(wings.find((w) => w.id === selectedWingId) ?? null);

	async function loadAll(opts: { force?: boolean } = {}) {
		loading = true;
		try {
			if (opts.force) {
				await Promise.all([
					listMemoryWingsQuery().refresh(),
					listMemoryWingEdgesQuery().refresh(),
					getMemoryStatsQuery().refresh(),
				]);
			}
			const [wingsResult, edgesResult, statsResult] = await Promise.all([
				listMemoryWingsQuery() as Promise<MemoryWingRow[]>,
				listMemoryWingEdgesQuery() as Promise<MemoryWingEdge[]>,
				getMemoryStatsQuery() as Promise<MemoryStats>,
			]);
			wings = wingsResult;
			edges = edgesResult;
			stats = statsResult;
		} finally {
			loading = false;
		}
	}

	function selectWing(id: string) {
		selectedWingId = id;
		selectedDrawerId = null;
		drawerDetail = null;
	}

	function closeWing() {
		selectedWingId = null;
		selectedDrawerId = null;
		drawerDetail = null;
	}

	async function selectDrawer(id: string) {
		selectedDrawerId = id;
		drawerDetail = null;
		const result = (await getMemoryDrawerQuery({ id })) as MemoryDrawerDetail | null;
		drawerDetail = result;
	}

	function closeDrawerDetail() {
		selectedDrawerId = null;
		drawerDetail = null;
	}

	async function removeDrawer(id: string) {
		if (!confirm('Delete this memory drawer? This cannot be undone.')) return;
		await deleteMemoryDrawerCommand({ id });
		closeDrawerDetail();
		// Refresh counts.
		await loadAll({ force: true });
	}

	function handleSearchHit(hit: { drawerId: string; wingId: string }) {
		selectedWingId = hit.wingId;
		void selectDrawer(hit.drawerId);
	}

	async function triggerMinePending() {
		if (mining) return;
		mining = true;
		mineResult = null;
		try {
			const result = await mineAllPendingCommand();
			mineResult = { conversationsScanned: result.conversationsScanned, enqueued: result.enqueued };
			// Poll stats for ~30s so the chip updates as jobs complete.
			let ticks = 0;
			pollTimer = setInterval(async () => {
				ticks += 1;
				await Promise.all([getMemoryStatsQuery().refresh(), listMemoryWingsQuery().refresh()]);
				stats = (await getMemoryStatsQuery()) as MemoryStats;
				wings = (await listMemoryWingsQuery()) as MemoryWingRow[];
				if (ticks >= 15 || stats.pendingMineJobs === 0) {
					if (pollTimer) clearInterval(pollTimer);
					pollTimer = null;
				}
			}, 2000);
		} finally {
			mining = false;
		}
	}

	function formatNum(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
		return String(n);
	}

	function relativeTime(d: string | Date | null): string {
		if (!d) return 'never';
		const date = typeof d === 'string' ? new Date(d) : d;
		const diff = Date.now() - date.getTime();
		if (diff < 60_000) return 'just now';
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
		if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
		return `${Math.floor(diff / 86_400_000)}d ago`;
	}

	onMount(() => {
		void loadAll();
		return () => {
			if (pollTimer) clearInterval(pollTimer);
		};
	});
</script>

<svelte:head>
	<title>Memory Palace · AgentStudio</title>
</svelte:head>

<div class="memory-page">
	<PageHeader title="Memory palace" subtitle="Concentric map of wings · rooms · closets · drawers" live={!!stats && stats.pendingMineJobs > 0}>
		{#snippet chips()}
			{#if stats}
				<span class="console-chip">{stats.wingCount} wings</span>
				<span class="console-chip">{stats.drawerCount} drawers</span>
				<span class="console-chip">{formatNum(stats.tokenSum)} tok</span>
				<span class="console-chip" title="Conversations represented in the palace">
					{stats.minedConversationCount}/{stats.conversationCount} mined
				</span>
				<span
					class="console-chip"
					title="Drawers with a vector embedding (needed for semantic search)"
					class:is-warn={stats.embeddingCoverage < 1}
				>
					{Math.round(stats.embeddingCoverage * 100)}% embedded
				</span>
				<span class="console-chip" title="Most recent drawer creation">
					last {relativeTime(stats.lastMinedAt)}
				</span>
				{#if stats.pendingMineJobs > 0}
					<span class="console-chip is-run">
						<span class="pulse-dot"></span>
						{stats.pendingMineJobs} mining
					</span>
				{/if}
			{/if}
		{/snippet}
		{#snippet actions()}
			<button
				class="btn btn-xs {showHowItWorks ? 'btn-neutral' : 'btn-ghost'}"
				onclick={() => (showHowItWorks = !showHowItWorks)}
				title="How the memory palace works"
			>
				How it works
			</button>
			<button
				class="btn btn-xs"
				onclick={() => (showReorganize = true)}
				title="Preview wing merges, closet consolidations, and embedding backfills before applying"
			>
				Reorganize
			</button>
			<button
				class="btn btn-xs btn-primary"
				onclick={triggerMinePending}
				disabled={mining}
				title="Sweep all your conversations and queue mining for any messages that aren't memorized yet"
			>
				{mining ? 'Queueing…' : 'Mine pending'}
			</button>
			<div class="join">
				<button
					class="btn join-item btn-xs {viewMode === 'map' ? 'btn-neutral' : 'btn-ghost'}"
					onclick={() => (viewMode = 'map')}
				>
					Map
				</button>
				<button
					class="btn join-item btn-xs {viewMode === 'list' ? 'btn-neutral' : 'btn-ghost'}"
					onclick={() => (viewMode = 'list')}
				>
					List
				</button>
			</div>
		{/snippet}
	</PageHeader>

	{#if showHowItWorks}
		<aside class="memory-explain">
			<div class="memory-explain__head">
				<span class="memory-explain__label">How the memory palace works</span>
				<button class="console-iconbtn" onclick={() => (showHowItWorks = false)} aria-label="Close" title="Close">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-4 w-4"><path d="M18 6L6 18M6 6l12 12"/></svg>
				</button>
			</div>
			<ol class="memory-explain__steps">
				<li>
					<span class="memory-explain__step">1 · Mine</span>
					<span>When a chat finishes, a <code>memory_mine</code> job extracts the dominant subject (a <em>wing</em>) and per-turn topics (<em>closets</em>) via a small LLM call.</span>
				</li>
				<li>
					<span class="memory-explain__step">2 · Dedupe on write</span>
					<span>Wings dedupe by slug, then alias overlap, then case-insensitive name. Rooms dedupe per (wing, day, conversation). Drawers skip any chat message they've already memorized.</span>
				</li>
				<li>
					<span class="memory-explain__step">3 · Embed + tag</span>
					<span>Each drawer gets a 1536-dim embedding (text-embedding-3-small) plus an AAAK index of people / locations / events / items / topics for the search overlay.</span>
				</li>
				<li>
					<span class="memory-explain__step">4 · Reorganize</span>
					<span>The palace doesn't reorganize on its own. <strong>Reorganize</strong> previews rule-based merges (similar wings, near-duplicate closets) plus an embedding backfill before applying. <strong>Mine pending</strong> sweeps any conversation whose new messages aren't yet memorized.</span>
				</li>
			</ol>
			{#if mineResult}
				<div class="memory-explain__result">
					Scanned {mineResult.conversationsScanned} conversation{mineResult.conversationsScanned === 1 ? '' : 's'} · enqueued {mineResult.enqueued} mining job{mineResult.enqueued === 1 ? '' : 's'}.
					{#if stats && stats.pendingMineJobs > 0}
						Stats refresh every 2s while jobs run.
					{/if}
				</div>
			{/if}
		</aside>
	{/if}

	<SearchOverlay onSelectHit={handleSearchHit} />

	<ReorganizePanel bind:open={showReorganize} onApplied={() => void loadAll({ force: true })} />

	<div class="memory-page__body" class:has-panel={!!selectedWing}>
		<div class="memory-page__main">
			{#if loading}
				<div class="memory-page__loading">
					<span class="loading loading-spinner loading-md text-primary"></span>
				</div>
			{:else if viewMode === 'map'}
				<div class="memory-page__map-wrap">
					<MemoryMap
						{wings}
						{edges}
						{selectedWingId}
						onSelect={selectWing}
					/>
				</div>
				<div class="memory-page__list-fallback">
					<WingList {wings} {selectedWingId} onSelect={selectWing} />
				</div>
			{:else}
				<WingList {wings} {selectedWingId} onSelect={selectWing} />
			{/if}
		</div>

		{#if selectedWing}
			<aside class="memory-page__rail">
				{#if drawerDetail}
					<DrawerDetailPanel
						drawer={drawerDetail}
						onBack={closeDrawerDetail}
						onDelete={removeDrawer}
					/>
				{:else}
					<WingDetailPanel
						wing={selectedWing}
						{selectedDrawerId}
						onSelectDrawer={selectDrawer}
						onClose={closeWing}
					/>
				{/if}
			</aside>
		{/if}
	</div>
</div>

<style>
	.memory-page {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}

	.memory-explain {
		flex: 0 0 auto;
		margin: 8px 12px 0;
		padding: 10px 14px;
		background: color-mix(in oklab, var(--color-primary) 4%, var(--color-base-100));
		border: 1px solid color-mix(in oklab, var(--color-primary) 22%, var(--color-base-300));
		border-radius: 10px;
		font-family: Consolas, 'Cascadia Code', monospace;
		font-size: 11.5px;
		color: var(--color-base-content);
	}

	.memory-explain__head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 6px;
	}

	.memory-explain__label {
		font-size: 9.5px;
		text-transform: uppercase;
		letter-spacing: 0.16em;
		color: color-mix(in oklab, var(--color-base-content) 50%, transparent);
		font-weight: 600;
	}

	.memory-explain__steps {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 6px 18px;
	}

	.memory-explain__steps li {
		display: flex;
		gap: 8px;
		line-height: 1.45;
	}

	.memory-explain__step {
		flex: 0 0 auto;
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--color-primary);
		min-width: 86px;
		padding-top: 1px;
	}

	.memory-explain code {
		font-size: 11px;
		background: var(--color-base-200);
		padding: 0 4px;
		border-radius: 3px;
	}

	.memory-explain__result {
		margin-top: 8px;
		padding-top: 8px;
		border-top: 1px dashed color-mix(in oklab, var(--color-primary) 25%, var(--color-base-300));
		font-size: 11px;
		color: var(--color-primary);
	}

	@media (max-width: 47.99rem) {
		.memory-explain__steps {
			grid-template-columns: 1fr;
		}
	}

	.memory-page__body {
		flex: 1;
		display: grid;
		grid-template-columns: 1fr;
		gap: 0;
		min-height: 0;
		min-width: 0;
	}

	.memory-page__body.has-panel {
		grid-template-columns: 1fr 420px;
	}

	.memory-page__main {
		min-width: 0;
		min-height: 0;
		padding: 12px;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.memory-page__loading {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.memory-page__map-wrap {
		flex: 1;
		min-height: 0;
		display: flex;
	}

	.memory-page__list-fallback {
		display: none;
	}

	.memory-page__rail {
		border-left: 1px solid var(--color-base-300);
		background: color-mix(in oklab, var(--color-base-content) 1%, var(--color-base-100));
		padding: 14px;
		overflow-y: auto;
		min-height: 0;
		min-width: 0;
	}

	@media (max-width: 47.99rem) {
		.memory-page__body.has-panel {
			grid-template-columns: 1fr;
		}

		.memory-page__main {
			display: none;
		}

		.memory-page__rail {
			border-left: 0;
			padding: 12px;
		}

		.memory-page__body:not(.has-panel) .memory-page__main {
			display: flex;
		}

		/* On mobile, hide the SVG canvas and show the list fallback. */
		.memory-page__map-wrap {
			display: none;
		}

		.memory-page__list-fallback {
			display: block;
			flex: 1;
			min-height: 0;
			overflow-y: auto;
		}
	}
</style>
