<script lang="ts">
	import {
		listMemoryRoomsQuery,
		type MemoryRoomRow,
		type MemoryWingRow,
	} from '$lib/memory/memory.remote';
	import RoomBlock from '$lib/memory/RoomBlock.svelte';
	import { kindColor, wingInitials } from '$lib/memory/memory-map.layout';

	let {
		wing,
		selectedDrawerId = null,
		onSelectDrawer,
		onClose,
	}: {
		wing: MemoryWingRow;
		selectedDrawerId?: string | null;
		onSelectDrawer?: (id: string) => void;
		onClose?: () => void;
	} = $props();

	let rooms = $state<MemoryRoomRow[]>([]);
	let loading = $state(false);
	let expandedRoomId = $state<string | null>(null);

	const colors = $derived(kindColor((wing.kind ?? 'topic') as 'person' | 'project' | 'topic' | 'agent'));

	$effect(() => {
		if (wing.id) {
			void loadRooms(wing.id);
		}
	});

	async function loadRooms(wingId: string) {
		loading = true;
		rooms = [];
		expandedRoomId = null;
		try {
			const result = (await listMemoryRoomsQuery({ wingId })) as MemoryRoomRow[];
			rooms = result;
			if (result.length > 0) expandedRoomId = result[0].id;
		} finally {
			loading = false;
		}
	}

	function toggleRoom(roomId: string) {
		expandedRoomId = expandedRoomId === roomId ? null : roomId;
	}

	type Bucket = 'today' | 'yesterday' | 'this_week' | 'earlier';
	const BUCKET_LABELS: Record<Bucket, string> = {
		today: 'Today',
		yesterday: 'Yesterday',
		this_week: 'Earlier this week',
		earlier: 'Earlier',
	};
	const BUCKET_ORDER: Bucket[] = ['today', 'yesterday', 'this_week', 'earlier'];

	function bucketFor(d: string | Date): Bucket {
		const date = typeof d === 'string' ? new Date(d) : d;
		const now = new Date();
		const startToday = new Date(now);
		startToday.setHours(0, 0, 0, 0);
		const startYesterday = new Date(startToday);
		startYesterday.setDate(startYesterday.getDate() - 1);
		const startThisWeek = new Date(startToday);
		startThisWeek.setDate(startThisWeek.getDate() - 7);
		if (date >= startToday) return 'today';
		if (date >= startYesterday) return 'yesterday';
		if (date >= startThisWeek) return 'this_week';
		return 'earlier';
	}

	const groupedRooms = $derived.by(() => {
		const buckets = new Map<Bucket, MemoryRoomRow[]>();
		for (const r of rooms) {
			const b = bucketFor(r.occurredAt);
			const list = buckets.get(b) ?? [];
			list.push(r);
			buckets.set(b, list);
		}
		return BUCKET_ORDER.filter((b) => buckets.has(b)).map((b) => ({
			label: BUCKET_LABELS[b],
			rooms: buckets.get(b) ?? [],
		}));
	});
</script>

<div class="wing-panel">
	<header class="wing-panel__head">
		<div class="wing-panel__avatar {colors.className}" style:background={colors.fill} style:border-color={colors.stroke} style:color={colors.text}>
			{wingInitials(wing.name)}
		</div>
		<div class="wing-panel__title">
			<div class="wing-panel__name-row">
				<h2 class="wing-panel__name">{wing.name}</h2>
				<span class="wing-panel__kind {colors.className}">{wing.kind}</span>
			</div>
			{#if wing.aliases?.length}
				<div class="wing-panel__aliases">aka {wing.aliases.join(', ')}</div>
			{/if}
		</div>
		{#if onClose}
			<button class="console-iconbtn" onclick={onClose} aria-label="Close" title="Close">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-4 w-4"><path d="M18 6L6 18M6 6l12 12"/></svg>
			</button>
		{/if}
	</header>

	{#if wing.summary}
		<p class="wing-panel__summary">{wing.summary}</p>
	{/if}

	<div class="wing-panel__stats">
		<div class="wing-panel__stat">
			<span class="wing-panel__stat-v">{wing.roomCount}</span>
			<span class="wing-panel__stat-l">rooms</span>
		</div>
		<div class="wing-panel__stat">
			<span class="wing-panel__stat-v">{wing.drawerCount}</span>
			<span class="wing-panel__stat-l">drawers</span>
		</div>
		<div class="wing-panel__stat">
			<span class="wing-panel__stat-v">
				{wing.lastTouchedAt ? new Date(wing.lastTouchedAt).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '—'}
			</span>
			<span class="wing-panel__stat-l">last seen</span>
		</div>
	</div>

	<div class="wing-panel__rooms">
		{#if loading}
			<div class="wing-panel__skeleton">
				<div class="wing-panel__skeleton-row"></div>
				<div class="wing-panel__skeleton-row"></div>
				<div class="wing-panel__skeleton-row"></div>
			</div>
		{:else if rooms.length === 0}
			<div class="wing-panel__empty">No rooms in this wing yet.</div>
		{:else}
			{#each groupedRooms as group (group.label)}
				<div class="wing-panel__group">
					<div class="wing-panel__group-label">{group.label}</div>
					<div class="wing-panel__group-rooms">
						{#each group.rooms as room (room.id)}
							<RoomBlock
								{room}
								expanded={expandedRoomId === room.id}
								{selectedDrawerId}
								onToggle={toggleRoom}
								onSelectDrawer={(id) => onSelectDrawer?.(id)}
							/>
						{/each}
					</div>
				</div>
			{/each}
		{/if}
	</div>
</div>

<style>
	.wing-panel {
		display: flex;
		flex-direction: column;
		gap: 12px;
		font-family: Consolas, 'Cascadia Code', monospace;
		font-size: 12px;
		min-height: 0;
	}

	.wing-panel__head {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.wing-panel__avatar {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		border-radius: 10px;
		border: 1.5px solid;
		font-size: 14px;
		font-weight: 700;
		flex: 0 0 auto;
	}

	.wing-panel__title {
		flex: 1;
		min-width: 0;
	}

	.wing-panel__name-row {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.wing-panel__name {
		margin: 0;
		font-size: 15px;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.wing-panel__kind {
		font-size: 9.5px;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		padding: 1px 6px;
		border-radius: 3px;
		border: 1px solid currentColor;
		flex: 0 0 auto;
	}

	.wing-panel__kind.is-person { color: var(--color-primary); }
	.wing-panel__kind.is-project { color: var(--color-secondary); }
	.wing-panel__kind.is-topic { color: var(--color-accent); }
	.wing-panel__kind.is-agent { color: var(--color-info); }

	.wing-panel__aliases {
		font-size: 10px;
		font-style: italic;
		color: color-mix(in oklab, var(--color-base-content) 50%, transparent);
		margin-top: 1px;
	}

	.wing-panel__summary {
		margin: 0;
		font-size: 12px;
		line-height: 1.55;
		color: color-mix(in oklab, var(--color-base-content) 75%, transparent);
		padding: 8px 10px;
		background: var(--color-base-200);
		border-left: 2px solid var(--color-primary);
		border-radius: 4px;
	}

	.wing-panel__stats {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 8px;
	}

	.wing-panel__stat {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 6px 8px;
		background: var(--color-base-200);
		border: 1px solid var(--color-base-300);
		border-radius: 6px;
	}

	.wing-panel__stat-v {
		font-size: 14px;
		font-weight: 600;
		color: var(--color-base-content);
	}

	.wing-panel__stat-l {
		font-size: 9.5px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: color-mix(in oklab, var(--color-base-content) 50%, transparent);
	}

	.wing-panel__rooms {
		display: flex;
		flex-direction: column;
		gap: 12px;
		min-height: 0;
	}

	.wing-panel__group {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.wing-panel__group-label {
		font-size: 9.5px;
		text-transform: uppercase;
		letter-spacing: 0.16em;
		color: color-mix(in oklab, var(--color-base-content) 50%, transparent);
	}

	.wing-panel__group-rooms {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.wing-panel__skeleton {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.wing-panel__skeleton-row {
		height: 36px;
		border-radius: 6px;
		background: linear-gradient(
			90deg,
			var(--color-base-200) 0%,
			color-mix(in oklab, var(--color-base-content) 5%, var(--color-base-200)) 50%,
			var(--color-base-200) 100%
		);
		background-size: 200% 100%;
		animation: panel-shimmer 1.4s ease-in-out infinite;
	}

	@keyframes panel-shimmer {
		0% { background-position: 200% 0; }
		100% { background-position: -200% 0; }
	}

	.wing-panel__empty {
		padding: 12px;
		font-size: 11.5px;
		font-style: italic;
		color: color-mix(in oklab, var(--color-base-content) 45%, transparent);
		text-align: center;
	}
</style>
