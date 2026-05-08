<script lang="ts">
	import {
		listMemoryClosetsQuery,
		listMemoryDrawersQuery,
		type MemoryClosetRow,
		type MemoryDrawerRow,
		type MemoryRoomRow,
	} from '$lib/memory/memory.remote';
	import DrawerCard from '$lib/memory/DrawerCard.svelte';

	let {
		room,
		expanded = false,
		selectedDrawerId = null,
		onSelectDrawer,
		onToggle,
	}: {
		room: MemoryRoomRow;
		expanded?: boolean;
		selectedDrawerId?: string | null;
		onSelectDrawer?: (id: string) => void;
		onToggle?: (roomId: string) => void;
	} = $props();

	let closets = $state<MemoryClosetRow[]>([]);
	let drawers = $state<MemoryDrawerRow[]>([]);
	let selectedClosetId = $state<string | null>(null);
	let loading = $state(false);

	$effect(() => {
		if (expanded && closets.length === 0 && !loading) {
			void loadClosets();
		}
	});

	async function loadClosets() {
		loading = true;
		try {
			const result = (await listMemoryClosetsQuery({ roomId: room.id })) as MemoryClosetRow[];
			closets = result;
			if (result.length > 0 && !selectedClosetId) {
				selectedClosetId = result[0].id;
				await loadDrawers(result[0].id);
			}
		} finally {
			loading = false;
		}
	}

	async function loadDrawers(closetId: string) {
		const result = (await listMemoryDrawersQuery({ closetId })) as MemoryDrawerRow[];
		drawers = result;
	}

	async function pickCloset(id: string) {
		selectedClosetId = id;
		await loadDrawers(id);
	}

	function formatTime(d: string | Date): string {
		const date = typeof d === 'string' ? new Date(d) : d;
		return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
	}
</script>

<div class="room-block" class:is-expanded={expanded}>
	<button class="room-block__head" onclick={() => onToggle?.(room.id)}>
		<span class="room-block__caret" class:is-open={expanded}>
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-3 w-3"><path d="M9 18l6-6-6-6"/></svg>
		</span>
		<div class="room-block__head-main">
			<span class="room-block__label">{room.label}</span>
			<span class="room-block__time">{formatTime(room.occurredAt)}</span>
		</div>
		<div class="room-block__counts">
			<span class="room-block__count" title="Closets">{room.closetCount}c</span>
			<span class="room-block__count" title="Drawers">{room.drawerCount}d</span>
			{#if room.conversationId}
				<a class="room-block__convo" href={`/chat/${room.conversationId}`} aria-label="Open chat" title="Open chat" onclick={(e) => e.stopPropagation()}>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-3 w-3"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
				</a>
			{/if}
		</div>
	</button>

	{#if expanded}
		<div class="room-block__body">
			{#if loading && closets.length === 0}
				<div class="room-block__skeleton">Loading closets…</div>
			{:else if closets.length === 0}
				<div class="room-block__empty">No closets in this room.</div>
			{:else}
				<div class="room-block__closets">
					{#each closets as closet (closet.id)}
						<button
							class="room-block__closet-tab"
							class:is-active={selectedClosetId === closet.id}
							onclick={() => pickCloset(closet.id)}
							title={closet.summary ?? closet.topic}
						>
							{closet.topic}
							<span class="room-block__closet-count">{closet.drawerCount}</span>
						</button>
					{/each}
				</div>

				<div class="room-block__drawers">
					{#each drawers as drawer (drawer.id)}
						<DrawerCard
							{drawer}
							selected={selectedDrawerId === drawer.id}
							onSelect={(id) => onSelectDrawer?.(id)}
						/>
					{:else}
						<div class="room-block__empty">No drawers in this closet.</div>
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.room-block {
		border: 1px solid var(--color-base-300);
		border-radius: 8px;
		background: color-mix(in oklab, var(--color-base-content) 1%, var(--color-base-100));
		overflow: hidden;
		font-family: Consolas, 'Cascadia Code', monospace;
	}

	.room-block.is-expanded {
		background: var(--color-base-100);
		border-color: color-mix(in oklab, var(--color-primary) 25%, var(--color-base-300));
	}

	.room-block__head {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 10px;
		width: 100%;
		background: transparent;
		border: 0;
		cursor: pointer;
		font-family: inherit;
		text-align: left;
		color: var(--color-base-content);
	}

	.room-block__head:hover {
		background: color-mix(in oklab, var(--color-base-content) 3%, transparent);
	}

	.room-block__caret {
		display: inline-flex;
		align-items: center;
		transition: transform 120ms;
		opacity: 0.6;
	}

	.room-block__caret.is-open {
		transform: rotate(90deg);
		opacity: 1;
	}

	.room-block__head-main {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
		gap: 1px;
	}

	.room-block__label {
		font-size: 12px;
		font-weight: 500;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.room-block__time {
		font-size: 10px;
		color: color-mix(in oklab, var(--color-base-content) 50%, transparent);
	}

	.room-block__counts {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.room-block__count {
		font-size: 10px;
		color: color-mix(in oklab, var(--color-base-content) 55%, transparent);
		background: var(--color-base-200);
		padding: 1px 5px;
		border-radius: 3px;
	}

	.room-block__convo {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		border-radius: 4px;
		color: var(--color-primary);
		text-decoration: none;
	}

	.room-block__convo:hover {
		background: color-mix(in oklab, var(--color-primary) 14%, transparent);
	}

	.room-block__body {
		padding: 8px 10px 10px;
		border-top: 1px solid var(--color-base-300);
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.room-block__closets {
		display: flex;
		gap: 4px;
		flex-wrap: wrap;
	}

	.room-block__closet-tab {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 3px 8px;
		border-radius: 999px;
		background: var(--color-base-200);
		border: 1px solid var(--color-base-300);
		color: color-mix(in oklab, var(--color-base-content) 70%, transparent);
		font-family: inherit;
		font-size: 11px;
		cursor: pointer;
	}

	.room-block__closet-tab:hover {
		color: var(--color-base-content);
	}

	.room-block__closet-tab.is-active {
		background: color-mix(in oklab, var(--color-primary) 12%, var(--color-base-200));
		border-color: var(--color-primary);
		color: var(--color-primary);
	}

	.room-block__closet-count {
		font-size: 9.5px;
		opacity: 0.7;
	}

	.room-block__drawers {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.room-block__empty,
	.room-block__skeleton {
		padding: 10px 6px;
		font-size: 11px;
		font-style: italic;
		color: color-mix(in oklab, var(--color-base-content) 45%, transparent);
	}
</style>
