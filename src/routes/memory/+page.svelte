<script lang="ts">
	import { onMount } from 'svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import {
		listMemoryWingsQuery,
		listMemoryRoomsQuery,
		listMemoryClosetsQuery,
		listMemoryDrawersQuery,
		searchMemoryQuery,
		deleteMemoryDrawerCommand,
	} from '$lib/memory/memory.remote';

	type Wing = { id: string; name: string; kind: string; aliases: string[] | null; summary: string | null };
	type Room = { id: string; label: string; occurredAt: string | Date };
	type Closet = { id: string; topic: string };
	type Drawer = {
		id: string;
		role: string;
		content: string;
		aaak: unknown;
		tokenCount: number;
		occurredAt: string | Date;
	};

	let wings = $state<Wing[]>([]);
	let rooms = $state<Room[]>([]);
	let closets = $state<Closet[]>([]);
	let drawers = $state<Drawer[]>([]);

	let selectedWing = $state<string | null>(null);
	let selectedRoom = $state<string | null>(null);
	let selectedCloset = $state<string | null>(null);

	let searchQuery = $state('');
	let useRerank = $state(false);
	let topK = $state(5);
	type SearchHit = {
		drawerId: string;
		content: string;
		wingName: string;
		closetTopic: string;
		occurredAt: string | Date;
		finalScore: number;
	};
	let searchResults = $state<SearchHit[]>([]);
	let searching = $state(false);

	async function loadWings() {
		wings = (await listMemoryWingsQuery()) as Wing[];
	}

	async function pickWing(id: string) {
		selectedWing = id;
		selectedRoom = null;
		selectedCloset = null;
		closets = [];
		drawers = [];
		rooms = (await listMemoryRoomsQuery({ wingId: id })) as Room[];
	}

	async function pickRoom(id: string) {
		selectedRoom = id;
		selectedCloset = null;
		drawers = [];
		closets = (await listMemoryClosetsQuery({ roomId: id })) as Closet[];
	}

	async function pickCloset(id: string) {
		selectedCloset = id;
		drawers = (await listMemoryDrawersQuery({ closetId: id })) as Drawer[];
	}

	async function runSearch() {
		if (!searchQuery.trim()) return;
		searching = true;
		try {
			searchResults = (await searchMemoryQuery({
				query: searchQuery.trim(),
				topK,
				useRerank,
			})) as unknown as SearchHit[];
		} finally {
			searching = false;
		}
	}

	async function removeDrawer(id: string) {
		if (!confirm('Delete this memory drawer?')) return;
		await deleteMemoryDrawerCommand({ id });
		drawers = drawers.filter((d) => d.id !== id);
	}

	function formatDate(d: string | Date) {
		const date = typeof d === 'string' ? new Date(d) : d;
		return date.toISOString().slice(0, 16).replace('T', ' ');
	}

	onMount(() => {
		void loadWings();
	});
</script>

<svelte:head>
	<title>Memory Palace · AgentStudio</title>
</svelte:head>

<div class="flex h-full min-h-0 flex-col">
	<PageHeader title="Memory palace" subtitle="Hierarchical wings · rooms · closets · drawers" />
	<div class="min-h-0 flex-1 overflow-y-auto px-3 py-3 tablet:px-4 desktop:px-4 desktop:py-4 flex flex-col gap-4">

	<!-- Semantic search bar -->
	<div class="card bg-base-200 p-3">
		<form
			class="flex flex-wrap items-center gap-2"
			onsubmit={(e) => {
				e.preventDefault();
				void runSearch();
			}}
		>
			<input
				type="text"
				bind:value={searchQuery}
				placeholder="Search memory…"
				class="input input-sm input-bordered flex-1 min-w-[240px]"
			/>
			<label class="flex items-center gap-1 text-xs">
				<span>top-k</span>
				<input
					type="number"
					min="1"
					max="20"
					bind:value={topK}
					class="input input-xs input-bordered w-16"
				/>
			</label>
			<label class="flex items-center gap-1 text-xs">
				<input type="checkbox" bind:checked={useRerank} class="checkbox checkbox-xs" />
				rerank
			</label>
			<button type="submit" class="btn btn-sm btn-primary" disabled={searching || !searchQuery.trim()}>
				{searching ? 'Searching…' : 'Search'}
			</button>
		</form>
		{#if searchResults.length > 0}
			<ul class="mt-3 space-y-2">
				{#each searchResults as r (r.drawerId)}
					<li class="rounded border border-base-300 bg-base-100 p-2 text-xs">
						<div class="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide opacity-60">
							<span>{r.wingName} › {r.closetTopic}</span>
							<span>{formatDate(r.occurredAt)} · score {r.finalScore.toFixed(3)}</span>
						</div>
						<div class="whitespace-pre-wrap">{r.content}</div>
					</li>
				{/each}
			</ul>
		{/if}
	</div>

	<!-- 4-column browser -->
	<div class="grid flex-1 grid-cols-1 gap-3 md:grid-cols-4">
		<!-- Wings -->
		<section class="card bg-base-200 p-3">
			<h2 class="mb-2 text-xs font-semibold uppercase tracking-widest opacity-60">Wings</h2>
			<ul class="space-y-1">
				{#each wings as w (w.id)}
					<li>
						<button
							class="w-full rounded px-2 py-1 text-left text-sm hover:bg-base-300"
							class:bg-primary={selectedWing === w.id}
							class:text-primary-content={selectedWing === w.id}
							onclick={() => pickWing(w.id)}
						>
							<div class="flex items-center justify-between">
								<span class="truncate">{w.name}</span>
								<span class="badge badge-xs">{w.kind}</span>
							</div>
							{#if w.aliases && w.aliases.length > 0}
								<div class="mt-0.5 truncate text-[10px] opacity-60">
									aka {w.aliases.join(', ')}
								</div>
							{/if}
						</button>
					</li>
				{:else}
					<li class="text-xs opacity-50">No wings yet — chat to create memories.</li>
				{/each}
			</ul>
		</section>

		<!-- Rooms -->
		<section class="card bg-base-200 p-3">
			<h2 class="mb-2 text-xs font-semibold uppercase tracking-widest opacity-60">Rooms</h2>
			<ul class="space-y-1">
				{#each rooms as r (r.id)}
					<li>
						<button
							class="w-full rounded px-2 py-1 text-left text-sm hover:bg-base-300"
							class:bg-primary={selectedRoom === r.id}
							class:text-primary-content={selectedRoom === r.id}
							onclick={() => pickRoom(r.id)}
						>
							<div class="truncate">{r.label}</div>
							<div class="text-[10px] opacity-60">{formatDate(r.occurredAt)}</div>
						</button>
					</li>
				{:else}
					<li class="text-xs opacity-50">{selectedWing ? 'No rooms in this wing.' : 'Pick a wing.'}</li>
				{/each}
			</ul>
		</section>

		<!-- Closets -->
		<section class="card bg-base-200 p-3">
			<h2 class="mb-2 text-xs font-semibold uppercase tracking-widest opacity-60">Closets</h2>
			<ul class="space-y-1">
				{#each closets as c (c.id)}
					<li>
						<button
							class="w-full rounded px-2 py-1 text-left text-sm hover:bg-base-300"
							class:bg-primary={selectedCloset === c.id}
							class:text-primary-content={selectedCloset === c.id}
							onclick={() => pickCloset(c.id)}
						>
							{c.topic}
						</button>
					</li>
				{:else}
					<li class="text-xs opacity-50">{selectedRoom ? 'No closets.' : 'Pick a room.'}</li>
				{/each}
			</ul>
		</section>

		<!-- Drawers -->
		<section class="card bg-base-200 p-3">
			<h2 class="mb-2 text-xs font-semibold uppercase tracking-widest opacity-60">Drawers</h2>
			<ul class="space-y-2">
				{#each drawers as d (d.id)}
					<li class="rounded border border-base-300 bg-base-100 p-2 text-xs">
						<div class="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide opacity-60">
							<span>{d.role} · {d.tokenCount} tok</span>
							<button
								class="link link-error text-[10px]"
								onclick={() => removeDrawer(d.id)}
							>
								delete
							</button>
						</div>
						<div class="whitespace-pre-wrap">{d.content}</div>
						<div class="mt-1 text-[10px] opacity-50">{formatDate(d.occurredAt)}</div>
					</li>
				{:else}
					<li class="text-xs opacity-50">{selectedCloset ? 'No drawers.' : 'Pick a closet.'}</li>
				{/each}
			</ul>
		</section>
	</div>
	</div>
</div>
