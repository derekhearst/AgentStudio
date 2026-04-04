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
	} from '$lib/memory/memory.remote';

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

	async function handleEditImportance() {
		if (!memory) return;
		const next = window.prompt('Set importance (0-1)', String(memory.importance));
		if (!next) return;
		const parsed = Number(next);
		if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return;
		await updateMemoryCommand({ id: memory.id, importance: parsed });
		await refresh();
	}

	async function handleDelete() {
		if (!memory) return;
		await deleteMemoryCommand({ id: memory.id });
		window.location.href = '/memory';
	}
</script>

<section class="space-y-4">
	<a class="btn btn-sm btn-ghost" href="/memory">Back to Memory Explorer</a>

	{#if loading}
		<p class="text-sm text-base-content/70">Loading memory detail...</p>
	{:else if error}
		<p class="text-sm text-error">{error}</p>
	{:else if !memory}
		<p class="text-sm text-base-content/70">Memory not found.</p>
	{:else}
		<header class="rounded-3xl border border-base-300 bg-base-100 p-5">
			<div class="flex flex-wrap items-start justify-between gap-3">
				<div class="space-y-1">
					<h1 class="text-2xl font-bold">Memory Detail</h1>
					<p class="whitespace-pre-wrap text-sm">{memory.content}</p>
					<div class="flex flex-wrap gap-2 text-xs text-base-content/70">
						<span class="badge badge-outline">{memory.category}</span>
						<span>importance {memory.importance.toFixed(2)}</span>
						<span>accesses {memory.accessCount}</span>
					</div>
				</div>
				<div class="flex flex-wrap gap-2">
					<button class="btn btn-sm" type="button" onclick={handlePinToggle}>
						{memory.category === 'pinned' || memory.category.startsWith('pinned:') ? 'Unpin' : 'Pin'}
					</button>
					<button class="btn btn-sm btn-outline" type="button" onclick={handleEditContent}>Edit Content</button>
					<button class="btn btn-sm btn-outline" type="button" onclick={handleEditImportance}>Edit Importance</button>
					<button class="btn btn-sm btn-error btn-outline" type="button" onclick={handleDelete}>Delete</button>
				</div>
			</div>
		</header>

		<div class="grid gap-4 lg:grid-cols-2">
			<section class="rounded-3xl border border-base-300 bg-base-100 p-4">
				<h2 class="mb-3 text-lg font-semibold">Relation Graph</h2>
				{#if relations.length === 0}
					<p class="text-sm text-base-content/70">No explicit relation edges yet.</p>
				{:else}
					<div class="space-y-2">
						{#each relations as relation (relation.id)}
							<article class="rounded-2xl border border-base-300 bg-base-50 p-3 text-sm">
								<p class="font-medium">
									{relation.direction === 'outgoing' ? 'This memory' : 'Neighbor'}
									<span class="mx-1">{relation.relationType}</span>
									{relation.direction === 'outgoing' ? 'neighbor' : 'this memory'}
								</p>
								<p class="text-base-content/70">
									{relation.otherMemory?.content ?? 'Unknown memory'}
								</p>
								<p class="text-xs text-base-content/60">strength {relation.strength.toFixed(2)}</p>
							</article>
						{/each}
					</div>
				{/if}
			</section>

			<section class="rounded-3xl border border-base-300 bg-base-100 p-4">
				<h2 class="mb-3 text-lg font-semibold">Related Memories</h2>
				{#if related.length === 0}
					<p class="text-sm text-base-content/70">No related memories found yet.</p>
				{:else}
					<div class="space-y-2">
						{#each related as item (item.id)}
							<a class="block rounded-2xl border border-base-300 bg-base-50 p-3 text-sm" href={`/memory/${item.id}`}>
								<p class="line-clamp-2">{item.content}</p>
								<p class="mt-1 text-xs text-base-content/70">
									{item.category} | importance {item.importance.toFixed(2)}
								</p>
							</a>
						{/each}
					</div>
				{/if}
			</section>
		</div>
	{/if}
</section>
