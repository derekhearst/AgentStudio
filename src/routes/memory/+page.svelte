<svelte:head><title>Memory | DrokBot</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import { listDreamCyclesQuery, runDreamCycleCommand } from '$lib/memory/dream.remote';
	import {
		createMemoryCommand,
		deleteMemoryCommand,
		listMemoriesQuery,
		pinMemoryCommand,
		searchMemoriesQuery,
		unpinMemoryCommand,
		updateMemoryCommand
	} from '$lib/memory/memory.remote';

	type MemoryRow = Awaited<ReturnType<typeof listMemoriesQuery>>[number];
	type DreamRow = Awaited<ReturnType<typeof listDreamCyclesQuery>>[number];

	let search = $state('');
	let category = $state('');
	let createContent = $state('');
	let createCategory = $state('general');
	let createImportance = $state(0.6);
	let busy = $state(false);
	let memories = $state<MemoryRow[]>([]);
	let dreamCycles = $state<DreamRow[]>([]);
	let mode = $state<'hybrid' | 'semantic'>('hybrid');

	const categoryOptions = ['general', 'preference', 'project', 'constraint', 'person'];

	onMount(() => {
		void Promise.all([loadMemories(), loadDreamCycles()]);
	});

	async function loadMemories() {
		const trimmedSearch = search.trim();
		const trimmedCategory = category.trim();
		if (mode === 'semantic' && trimmedSearch.length > 0) {
			memories = await searchMemoriesQuery({ text: trimmedSearch, limit: 80 });
			return;
		}

		memories = await listMemoriesQuery({
			search: trimmedSearch.length > 0 ? trimmedSearch : undefined,
			category: trimmedCategory.length > 0 ? trimmedCategory : undefined,
			limit: 80
		});
	}

	async function loadDreamCycles() {
		dreamCycles = await listDreamCyclesQuery({ limit: 8 });
	}

	async function handleCreateMemory() {
		if (!createContent.trim() || busy) return;
		busy = true;
		try {
			await createMemoryCommand({
				content: createContent.trim(),
				category: createCategory,
				importance: createImportance
			});
			createContent = '';
			await loadMemories();
		} finally {
			busy = false;
		}
	}

	async function handleRunDreamCycle() {
		if (busy) return;
		busy = true;
		try {
			await runDreamCycleCommand({
				decayLambda: 0.03,
				pruneThreshold: 0.08,
				topCount: 24,
				conversationLimit: 12,
				lookbackHours: 72
			});
			await Promise.all([loadMemories(), loadDreamCycles()]);
		} finally {
			busy = false;
		}
	}

	async function handleDeleteMemory(id: string) {
		await deleteMemoryCommand({ id });
		await loadMemories();
	}

	async function handleTogglePin(memory: MemoryRow) {
		if (memory.category === 'pinned' || memory.category.startsWith('pinned:')) {
			await unpinMemoryCommand({ id: memory.id });
		} else {
			await pinMemoryCommand({ id: memory.id });
		}
		await loadMemories();
	}

	async function handleQuickEdit(memory: MemoryRow) {
		const next = window.prompt('Edit memory content', memory.content);
		if (!next || next.trim() === memory.content) return;
		await updateMemoryCommand({ id: memory.id, content: next.trim() });
		await loadMemories();
	}

	function isPinned(categoryName: string) {
		return categoryName === 'pinned' || categoryName.startsWith('pinned:');
	}
</script>

<section class="space-y-5">
	<header class="rounded-3xl border border-base-300 bg-base-100 p-5">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div>
				<h1 class="text-3xl font-bold">Memory Explorer</h1>
				<p class="text-sm text-base-content/70">
					Inspect durable memories, run semantic retrieval, and trigger dream consolidation.
				</p>
			</div>
			<button class="btn btn-primary" type="button" onclick={handleRunDreamCycle} disabled={busy}>
				Run Dream Cycle
			</button>
		</div>
	</header>

	<div class="grid gap-4 xl:grid-cols-[2fr_1fr]">
		<section class="space-y-4 rounded-3xl border border-base-300 bg-base-100 p-4">
			<div class="grid gap-2 md:grid-cols-[1.4fr_1fr_auto_auto]">
				<input
					class="input input-bordered"
					bind:value={search}
					placeholder="Search memories"
				/>
				<input
					class="input input-bordered"
					bind:value={category}
					placeholder="Category filter"
				/>
				<select class="select select-bordered" bind:value={mode}>
					<option value="hybrid">Hybrid</option>
					<option value="semantic">Semantic</option>
				</select>
				<button class="btn btn-outline" type="button" onclick={loadMemories}>Apply</button>
			</div>

			<div class="rounded-2xl border border-base-300 bg-base-200/30 p-3">
				<div class="grid gap-2 md:grid-cols-[1.6fr_1fr_1fr_auto]">
					<input
						class="input input-bordered"
						bind:value={createContent}
						placeholder="Add new memory"
					/>
					<select class="select select-bordered" bind:value={createCategory}>
						{#each categoryOptions as option (option)}
							<option value={option}>{option}</option>
						{/each}
					</select>
					<input
						type="number"
						min="0"
						max="1"
						step="0.05"
						class="input input-bordered"
						bind:value={createImportance}
					/>
					<button class="btn btn-success" type="button" onclick={handleCreateMemory} disabled={busy}>
						Save
					</button>
				</div>
			</div>

			<div class="space-y-2">
				{#if memories.length === 0}
					<p class="text-sm text-base-content/70">No memories matched the current filters.</p>
				{:else}
					{#each memories as memory (memory.id)}
						<article class="rounded-2xl border border-base-300 bg-base-50 p-4">
							<div class="flex flex-wrap items-start justify-between gap-2">
								<div class="space-y-1">
									<p class="whitespace-pre-wrap text-sm leading-relaxed">{memory.content}</p>
									<div class="flex flex-wrap gap-2 text-xs text-base-content/70">
										<span class="badge badge-outline">{memory.category}</span>
										<span>importance {memory.importance.toFixed(2)}</span>
										<span>accesses {memory.accessCount}</span>
									</div>
								</div>
								<div class="flex flex-wrap gap-1">
									<a class="btn btn-xs btn-outline" href={`/memory/${memory.id}`}>Detail</a>
									<button class="btn btn-xs" type="button" onclick={() => handleTogglePin(memory)}>
										{isPinned(memory.category) ? 'Unpin' : 'Pin'}
									</button>
									<button class="btn btn-xs btn-ghost" type="button" onclick={() => handleQuickEdit(memory)}>
										Edit
									</button>
									<button class="btn btn-xs btn-error btn-outline" type="button" onclick={() => handleDeleteMemory(memory.id)}>
										Delete
									</button>
								</div>
							</div>
						</article>
					{/each}
				{/if}
			</div>
		</section>

		<aside class="space-y-3 rounded-3xl border border-base-300 bg-base-100 p-4">
			<h2 class="text-lg font-semibold">Dream Cycle History</h2>
			{#if dreamCycles.length === 0}
				<p class="text-sm text-base-content/70">No dream cycles yet.</p>
			{:else}
				{#each dreamCycles as cycle (cycle.id)}
					<article class="rounded-2xl border border-base-300 bg-base-50 p-3 text-sm">
						<p class="font-medium">{new Date(cycle.startedAt).toLocaleString()}</p>
						<p class="text-base-content/70">{cycle.summary ?? 'No summary'}</p>
						<div class="mt-1 text-xs text-base-content/70">
							<span>created {cycle.memoriesCreated}</span>
							<span class="mx-2">|</span>
							<span>pruned {cycle.memoriesPruned}</span>
						</div>
					</article>
				{/each}
			{/if}
		</aside>
	</div>
</section>
