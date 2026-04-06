<svelte:head><title>Memory | DrokBot</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import {
		deleteMemoryCommand,
		importMemoriesCommand,
		listMemoriesQuery,
		pinMemoryCommand,
		unpinMemoryCommand,
		updateMemoryCommand
	} from '$lib/memory';
	import { getSettings } from '$lib/settings/settings.remote';
	import ModelSelector from '$lib/settings/ModelSelector.svelte';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';
	import { dreamPanel } from '$lib/state.svelte';

	type MemoryRow = Awaited<ReturnType<typeof listMemoriesQuery>>[number];

	const IMPORT_PROMPT = `I use a personal AI assistant that stores long-term memories about me.
Please help me transfer knowledge from our conversations here into my assistant.

List everything you know about me as concise, standalone facts — one fact per line.
Cover these categories:
- **preference** — likes, dislikes, communication style, tools I prefer
- **project** — things I'm working on, tech stack, goals
- **person** — people I've mentioned, relationships, roles
- **constraint** — limitations, deadlines, requirements I've stated
- **general** — anything else noteworthy

Format each fact as a single clear sentence. Do not use bullet markers or numbering.
Do not include uncertain or speculative information.
Do not include facts about yourself or our conversation mechanics.`;

	let search = $state('');
	let busy = $state(false);
	let memories = $state.raw<MemoryRow[]>([]);
	let allMemories = $state.raw<MemoryRow[]>([]);

	/* ── Importer modal state ────────────────────────── */
	let showImporter = $state(false);
	let importText = $state('');
	let importResult = $state<{ imported: number; memories: Array<{ content: string; category: string; importance: number }> } | null>(null);
	let promptCopied = $state(false);
	let importModel = $state('');

	let filterTimer: ReturnType<typeof setTimeout> | undefined;
	let dialogEl = $state<HTMLDialogElement | undefined>(undefined);

	onMount(() => {
		void loadMemories();
		void loadDefaultModel();
	});

	async function loadDefaultModel() {
		const settings = await getSettings();
		if (settings.defaultModel) importModel = settings.defaultModel;
	}

	async function loadMemories() {
		allMemories = await listMemoriesQuery({ limit: 200 });
		filterLocally();
	}

	function filterLocally() {
		const q = search.trim().toLowerCase();
		if (!q) {
			memories = allMemories;
		} else {
			memories = allMemories.filter(
				(m) => m.content.toLowerCase().includes(q) || m.category.toLowerCase().includes(q)
			);
		}
	}

	function handleSearchInput() {
		clearTimeout(filterTimer);
		filterTimer = setTimeout(filterLocally, 150);
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

	function isPinned(categoryName: string) {
		return categoryName === 'pinned' || categoryName.startsWith('pinned:');
	}

	function openImportModal() {
		showImporter = true;
		dialogEl?.showModal();
	}

	function closeImportModal() {
		dialogEl?.close();
		showImporter = false;
	}

	/* ── Importer handlers ───────────────────────────── */
	async function handleCopyPrompt() {
		await navigator.clipboard.writeText(IMPORT_PROMPT);
		promptCopied = true;
	}

	async function handleImport() {
		if (!importText.trim() || busy) return;
		busy = true;
		importResult = null;
		try {
			importResult = await importMemoriesCommand({ text: importText.trim(), model: importModel });
			if (importResult.imported > 0) {
				importText = '';
				await loadMemories();
			}
		} finally {
			busy = false;
		}
	}
</script>

<div class="flex h-full min-h-0 flex-col space-y-3 sm:space-y-4">
	<ContentPanel>
		{#snippet header()}
			<div>
				<h1 class="text-xl font-bold sm:text-3xl">Memory Explorer</h1>
				<p class="text-xs text-base-content/70 sm:text-sm">
					{memories.length} {memories.length === 1 ? 'memory' : 'memories'}
				</p>
			</div>
		{/snippet}
		{#snippet actions()}
			<button class="btn btn-sm btn-outline sm:btn-md" type="button" onclick={openImportModal}>Import</button>
			<button
				class="btn btn-sm btn-outline gap-1.5 sm:btn-md lg:hidden"
				type="button"
				onclick={() => (dreamPanel.open = true)}
			>
				Dream Cycles
				<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M9 5l7 7-7 7" /></svg>
			</button>
		{/snippet}
	</ContentPanel>

	<!-- Search -->
	<input
		class="input input-bordered input-sm mb-4 w-full shrink-0"
		bind:value={search}
		oninput={handleSearchInput}
		placeholder="Filter memories..."
	/>

	<!-- Memory list (scrollable) -->
	<div class="min-h-0 flex-1 overflow-y-auto rounded-xl bg-base-200/40 px-3 sm:px-4">
		{#if memories.length === 0}
			<p class="py-6 text-center text-sm text-base-content/40">No memories matched the current filters.</p>
		{:else}
			{#each memories as memory, i (memory.id)}
				{#if i > 0}
					<div class="border-t border-base-content/6"></div>
				{/if}
				<div class="flex items-start gap-3 py-3 sm:py-3.5">
					<div class="min-w-0 flex-1">
						<p class="whitespace-pre-wrap text-sm leading-relaxed">{memory.content}</p>
						<div class="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-base-content/40">
							<span class="rounded-md bg-base-content/6 px-1.5 py-0.5">{memory.category}</span>
							<span>imp {memory.importance.toFixed(2)}</span>
							<span>&middot;</span>
							<span>{memory.accessCount} access{memory.accessCount !== 1 ? 'es' : ''}</span>
						</div>
					</div>
					<div class="flex shrink-0 items-center gap-1">
						<a class="btn btn-ghost btn-xs" href={`/memory/${memory.id}`}>Detail</a>
						<button class="btn btn-ghost btn-xs" type="button" onclick={() => handleTogglePin(memory)}>
							{isPinned(memory.category) ? 'Unpin' : 'Pin'}
						</button>
						<button class="btn btn-ghost btn-xs text-error" type="button" onclick={() => handleDeleteMemory(memory.id)}>
							Delete
						</button>
					</div>
				</div>
			{/each}
		{/if}
	</div>
</div>

<!-- ════════════════════════════════════════════════
     IMPORT MODAL
     ════════════════════════════════════════════════ -->
<dialog bind:this={dialogEl} class="modal" onclose={() => (showImporter = false)}>
	<div class="modal-box max-w-2xl space-y-4">
		<div class="flex items-center justify-between">
			<h3 class="text-lg font-bold">Import Memories</h3>
			<button class="btn btn-ghost btn-sm btn-circle" type="button" onclick={closeImportModal} aria-label="Close">
				<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M6 18L18 6M6 6l12 12" /></svg>
			</button>
		</div>
		<p class="text-sm text-base-content/50">Copy the prompt below into ChatGPT / Claude / etc., then paste their response back.</p>

		<!-- Step 1 -->
		<div class="rounded-xl bg-base-200/40 px-4 py-3.5">
			<p class="mb-2.5 text-sm font-medium">Step 1 — Copy the extraction prompt</p>
			<textarea
				class="textarea textarea-bordered w-full font-mono text-xs"
				rows="6"
				readonly
				value={IMPORT_PROMPT}
			></textarea>
			<button class="btn btn-outline btn-sm mt-2" type="button" onclick={handleCopyPrompt}>
				{promptCopied ? 'Copied!' : 'Copy to Clipboard'}
			</button>
		</div>

		<!-- Step 2 -->
		<div class="rounded-xl bg-base-200/40 px-4 py-3.5">
			<p class="mb-2.5 text-sm font-medium">Step 2 — Paste the LLM's response</p>
			<div class="mb-2 flex flex-wrap items-center gap-3">
				<span class="text-xs text-base-content/40">Extraction model:</span>
				<ModelSelector value={importModel} onchange={(id) => (importModel = id)} size="sm" />
			</div>
			<textarea
				class="textarea textarea-bordered w-full text-sm"
				rows="6"
				bind:value={importText}
				placeholder="Paste the response from the other LLM here..."
			></textarea>
			<button
				class="btn btn-success btn-sm mt-2"
				type="button"
				onclick={handleImport}
				disabled={busy || !importText.trim()}
			>
				{busy ? 'Importing...' : 'Import Memories'}
			</button>
		</div>

		<!-- Result -->
		{#if importResult}
			<div class="rounded-xl border border-success/20 bg-success/5 px-4 py-3">
				{#if importResult.imported === 0}
					<p class="text-sm text-base-content/50">No new memories extracted (all duplicates or empty).</p>
				{:else}
					<p class="text-sm font-medium text-success">
						Imported {importResult.imported} {importResult.imported === 1 ? 'memory' : 'memories'}
					</p>
					<ul class="mt-2 space-y-1">
						{#each importResult.memories as m}
							<li class="text-sm">
								<span class="rounded-md bg-base-content/6 px-1.5 py-0.5 text-xs">{m.category}</span>
								<span class="ml-1">{m.content}</span>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		{/if}
	</div>
	<form method="dialog" class="modal-backdrop">
		<button type="submit">close</button>
	</form>
</dialog>



