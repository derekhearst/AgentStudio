<script lang="ts">
	import { onMount } from 'svelte';
	import { listMemoriesQuery } from '$lib/memory';

	type MemoryRow = Awaited<ReturnType<typeof listMemoriesQuery>>[number];

	let memories = $state<MemoryRow[]>([]);
	let totalRooms = $state(0);
	let totalWings = $state(0);
	let byHall = $state<Record<string, number>>({});

	onMount(() => {
		void loadPalaceSnapshot();
	});

	async function loadPalaceSnapshot() {
		memories = await listMemoriesQuery({ limit: 300 });
		const wingSet = new Set(memories.map((m) => m.wingId).filter(Boolean));
		const roomSet = new Set(memories.map((m) => m.roomId).filter(Boolean));
		totalWings = wingSet.size;
		totalRooms = roomSet.size;

		const counts: Record<string, number> = {};
		for (const memory of memories) {
			counts[memory.hallType] = (counts[memory.hallType] ?? 0) + 1;
		}
		byHall = counts;
	}
</script>

<div class="w-full space-y-2 pb-3">
	<h2 class="text-xl font-bold sm:text-3xl">Memory Palace</h2>
	<p class="text-xs text-base-content/70 sm:text-sm">Read-only snapshot of wings, rooms, and hall distribution.</p>
</div>

<div class="mt-3 space-y-3">
	<div class="grid grid-cols-3 gap-2 text-xs">
		<div class="rounded-lg bg-base-200/60 px-2 py-1.5 text-center">
			<p class="text-base-content/60">Wings</p>
			<p class="text-base-content">{totalWings}</p>
		</div>
		<div class="rounded-lg bg-base-200/60 px-2 py-1.5 text-center">
			<p class="text-base-content/60">Rooms</p>
			<p class="text-base-content">{totalRooms}</p>
		</div>
		<div class="rounded-lg bg-base-200/60 px-2 py-1.5 text-center">
			<p class="text-base-content/60">Drawers</p>
			<p class="text-base-content">{memories.length}</p>
		</div>
	</div>

	{#if memories.length === 0}
		<p class="py-4 text-center text-xs text-base-content/40">No palace memories yet.</p>
	{:else}
		<div class="space-y-2">
			{#each Object.entries(byHall) as [hall, count] (hall)}
				<div class="flex items-center justify-between rounded-xl px-2.5 py-2 transition-colors hover:bg-base-200">
					<p class="text-sm font-medium capitalize">{hall}</p>
					<span class="rounded-md bg-primary/10 px-1.5 py-0.5 text-xs text-primary">{count}</span>
				</div>
			{/each}
		</div>
	{/if}
</div>
