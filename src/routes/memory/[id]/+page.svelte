<svelte:head><title>Memory Detail | DrokBot</title></svelte:head>

<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import {
		deleteMemoryCommand,
		getMemoryByIdQuery,
		getMemoryRelationsQuery,
		getRelatedMemoriesQuery,
		pinMemoryCommand,
		unpinMemoryCommand,
		updateMemoryCommand
	} from '$lib/memory';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';

	const memoryId = $derived(page.params.id ?? '');

	type MemoryRow = NonNullable<Awaited<ReturnType<typeof getMemoryByIdQuery>>>;
	type RelatedRow = Awaited<ReturnType<typeof getRelatedMemoriesQuery>>[number];
	type RelationRow = Awaited<ReturnType<typeof getMemoryRelationsQuery>>[number];

	let memory = $state<MemoryRow | null>(null);
	let related = $state<RelatedRow[]>([]);
	let relations = $state<RelationRow[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);

	onMount(() => {
		void refresh();
	});

	async function refresh() {
		if (!memoryId) return;
		loading = true;
		error = null;
		try {
			const [memoryResult, relatedResult, relationResult] = await Promise.all([
				getMemoryByIdQuery({ id: memoryId }),
				getRelatedMemoriesQuery({ id: memoryId, depth: 2 }),
				getMemoryRelationsQuery({ id: memoryId })
			]);
			memory = memoryResult;
			related = relatedResult;
			relations = relationResult;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Failed to load memory detail';
		} finally {
			loading = false;
		}
	}

	async function handlePinToggle() {
		if (!memory) return;
		if (memory.category === 'pinned' || memory.category.startsWith('pinned:')) {
			await unpinMemoryCommand({ id: memory.id });
		} else {
			await pinMemoryCommand({ id: memory.id });
		}
		await refresh();
	}

	async function handleEditContent() {
		if (!memory) return;
		const next = window.prompt('Edit memory content', memory.content);
		if (!next || next.trim() === memory.content) return;
		await updateMemoryCommand({ id: memory.id, content: next.trim() });
		await refresh();
	}

	async function handleDelete() {
		if (!memory) return;
		await deleteMemoryCommand({ id: memory.id });
		window.location.href = '/memory';
	}
</script>

<section class="flex h-full min-h-0 flex-col space-y-3 sm:space-y-4">
	<a class="btn btn-sm btn-outline w-fit gap-1" href="/memory">
		<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M15 19l-7-7 7-7" /></svg>
		Memory Explorer
	</a>

	{#if loading}
		<p class="text-sm text-base-content/70">Loading memory detail...</p>
	{:else if error}
		<p class="text-sm text-error">{error}</p>
	{:else if !memory}
		<p class="text-sm text-base-content/70">Memory not found.</p>
	{:else}
		<ContentPanel>
			{#snippet header()}
				<div>
					<h1 class="text-xl font-bold sm:text-3xl">Memory Detail</h1>
					<p class="text-xs text-base-content/70 sm:text-sm">
						<span class="badge badge-sm">{memory?.category}</span>
						<span class="ml-1">importance {memory?.importance.toFixed(2)}</span>
						<span class="ml-1">&middot; {memory?.accessCount} access{memory?.accessCount !== 1 ? 'es' : ''}</span>
					</p>
				</div>
			{/snippet}
			{#snippet actions()}
				<button class="btn btn-sm btn-outline" type="button" onclick={handlePinToggle}>
					{memory?.category === 'pinned' || memory?.category.startsWith('pinned:') ? 'Unpin' : 'Pin'}
				</button>
				<button class="btn btn-sm btn-error btn-outline" type="button" onclick={handleDelete}>Delete</button>
			{/snippet}
		</ContentPanel>

		<!-- Content editable area -->
		<div class="rounded-xl border border-base-300 bg-base-100 p-3 sm:rounded-2xl sm:p-4">
			<div class="flex items-center justify-between gap-2 pb-2">
				<h2 class="text-sm font-semibold text-base-content/60">Content</h2>
				<button class="btn btn-ghost btn-xs" type="button" onclick={handleEditContent}>Edit</button>
			</div>
			<p class="whitespace-pre-wrap text-sm leading-relaxed">{memory?.content}</p>
		</div>

		<!-- Importance slider -->
		<div class="rounded-xl border border-base-300 bg-base-100 p-3 sm:rounded-2xl sm:p-4">
			<div class="flex items-center justify-between gap-2 pb-2">
				<h2 class="text-sm font-semibold text-base-content/60">Importance</h2>
				<span class="font-mono text-xs text-base-content/50">{memory?.importance.toFixed(2)}</span>
			</div>
			<input
				type="range"
				class="range range-sm range-primary"
				min="0"
				max="1"
				step="0.05"
				value={memory?.importance}
				onchange={(e) => {
					const val = Number(e.currentTarget.value);
					if (memory && Number.isFinite(val)) {
						void updateMemoryCommand({ id: memory.id, importance: val }).then(refresh);
					}
				}}
			/>
			<div class="mt-1 flex justify-between text-[10px] text-base-content/30">
				<span>Trivial</span>
				<span>Normal</span>
				<span>Critical</span>
			</div>
		</div>

		<!-- Relations & Related in a grid -->
		<div class="grid gap-3 sm:gap-4 lg:grid-cols-2">
			<div class="rounded-xl border border-base-300 bg-base-100 p-3 sm:rounded-2xl sm:p-4">
				<h2 class="pb-2 text-sm font-semibold text-base-content/60">Relation Graph</h2>
				{#if relations.length === 0}
					<p class="py-3 text-center text-xs text-base-content/40">No explicit relation edges yet.</p>
				{:else}
					<div class="space-y-2">
						{#each relations as relation (relation.id)}
							<div class="rounded-lg bg-base-200/40 px-3 py-2 text-sm">
								<p class="font-medium">
									{relation.direction === 'outgoing' ? 'This memory' : 'Neighbor'}
									<span class="mx-1 text-xs text-base-content/50">{relation.relationType}</span>
									{relation.direction === 'outgoing' ? 'neighbor' : 'this memory'}
								</p>
								<p class="mt-0.5 text-xs text-base-content/60">{relation.otherMemory?.content ?? 'Unknown memory'}</p>
								<p class="mt-0.5 text-[10px] text-base-content/40">strength {relation.strength.toFixed(2)}</p>
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<div class="rounded-xl border border-base-300 bg-base-100 p-3 sm:rounded-2xl sm:p-4">
				<h2 class="pb-2 text-sm font-semibold text-base-content/60">Related Memories</h2>
				{#if related.length === 0}
					<p class="py-3 text-center text-xs text-base-content/40">No related memories found yet.</p>
				{:else}
					<div class="space-y-2">
						{#each related as item (item.id)}
							<a class="block rounded-lg bg-base-200/40 px-3 py-2 text-sm transition-colors hover:bg-base-200" href={`/memory/${item.id}`}>
								<p class="line-clamp-2">{item.content}</p>
								<p class="mt-0.5 text-xs text-base-content/50">
									<span class="rounded-md bg-base-content/6 px-1.5 py-0.5">{item.category}</span>
									<span class="ml-1">imp {item.importance.toFixed(2)}</span>
								</p>
							</a>
						{/each}
					</div>
				{/if}
			</div>
		</div>
	{/if}
</section>

