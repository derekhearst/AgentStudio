<svelte:head><title>Memory Palace | AgentStudio</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import {
		buildImportPromptQuery,
		getPalaceTaxonomyQuery,
		importMemoriesCommand,
		listDreamingSessionsQuery,
		listMemoriesQuery,
	} from '$lib/memory';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';

	type MemoryRow = Awaited<ReturnType<typeof listMemoriesQuery>>[number];
	type WingRow = Awaited<ReturnType<typeof getPalaceTaxonomyQuery>>[number];
	type SessionRow = Awaited<ReturnType<typeof listDreamingSessionsQuery>>[number];
	type HallFilter = 'all' | 'facts' | 'events' | 'discoveries' | 'preferences' | 'advice';

	let search = $state('');
	let hallFilter = $state<HallFilter>('all');
	let selectedWingId = $state<string | null>(null);
	let selectedRoomId = $state<string | null>(null);

	let memories = $state<MemoryRow[]>([]);
	let wings = $state<WingRow[]>([]);
	let dreamingSessions = $state<SessionRow[]>([]);
	let showImportModal = $state(false);
	let importText = $state('');
	let importModel = $state('');
	let importPrompt = $state('');
	let importBusy = $state(false);
	let importError = $state<string | null>(null);
	let importResult = $state<{ extractedCount?: number; duplicateCount?: number } | null>(null);

	onMount(() => {
		void loadPalace();
	});

	async function loadPalace() {
		const [memoryRows, wingRows, sessions] = await Promise.all([
			listMemoriesQuery({ limit: 400 }),
			getPalaceTaxonomyQuery(),
			listDreamingSessionsQuery(),
		]);
		memories = memoryRows;
		wings = wingRows;
		dreamingSessions = sessions;

		if (!selectedWingId && wingRows.length > 0) {
			selectedWingId = wingRows[0].id;
		}
	}

	const selectedWing = $derived(wings.find((wing) => wing.id === selectedWingId) ?? null);
	const selectedRoom = $derived(selectedWing?.rooms.find((room) => room.id === selectedRoomId) ?? null);

	const roomMemories = $derived.by(() => {
		const q = search.trim().toLowerCase();
		return memories
			.filter((memory) => (selectedRoomId ? memory.roomId === selectedRoomId : selectedWingId ? memory.wingId === selectedWingId : true))
			.filter((memory) => (hallFilter === 'all' ? true : memory.hallType === hallFilter))
			.filter((memory) => {
				if (!q) return true;
				return memory.content.toLowerCase().includes(q) || memory.category.toLowerCase().includes(q);
			})
			.sort((a, b) => Number(b.importance) - Number(a.importance));
	});

	const tunnelMap = $derived.by(() => {
		const map = new Map<string, number>();
		for (const wing of wings) {
			for (const room of wing.rooms) {
				const key = room.name.trim().toLowerCase();
				map.set(key, (map.get(key) ?? 0) + 1);
			}
		}
		return map;
	});

	function selectWing(wingId: string) {
		selectedWingId = wingId;
		selectedRoomId = null;
	}

	async function generateImportPrompt() {
		importError = null;
		importPrompt = await buildImportPromptQuery({ includeExisting: false });
	}

	async function runImport() {
		const text = importText.trim();
		if (!text) {
			importError = 'Paste memory text to import.';
			return;
		}

		importBusy = true;
		importError = null;
		importResult = null;

		try {
			const result = await importMemoriesCommand({
				text,
				model: importModel.trim() || undefined,
			});
			importResult = result as { extractedCount?: number; duplicateCount?: number };
			await loadPalace();
		} catch (error) {
			importError = error instanceof Error ? error.message : 'Failed to import memories.';
		} finally {
			importBusy = false;
		}
	}

	function resetImportModal() {
		importError = null;
		importResult = null;
		importPrompt = '';
	}
</script>

<div class="flex h-full min-h-0 flex-col gap-4">
	<ContentPanel>
		{#snippet header()}
			<div class="flex w-full items-start justify-between gap-3">
				<div>
				<h1 class="text-xl font-bold sm:text-3xl">Memory Palace</h1>
				<p class="text-xs text-base-content/70 sm:text-sm">
					{wings.length} wings • {memories.length} drawers • {dreamingSessions.length} Dreaming Agent sessions
				</p>
				</div>
				<button
					type="button"
					class="btn btn-sm btn-outline"
					onclick={() => {
						showImportModal = true;
						resetImportModal();
					}}
				>
					Manual Import
				</button>
			</div>
		{/snippet}
	</ContentPanel>

	<div class="grid min-h-0 flex-1 gap-4 desktop:grid-cols-[280px_320px_minmax(0,1fr)]">
		<section class="min-h-0 rounded-2xl border border-base-300 bg-base-100 p-3">
			<h2 class="mb-2 text-sm font-semibold text-base-content/70">Wings</h2>
			<div class="space-y-2 overflow-y-auto">
				{#each wings as wing (wing.id)}
					<button
						type="button"
						onclick={() => selectWing(wing.id)}
						class={`w-full rounded-xl border px-3 py-2 text-left ${selectedWingId === wing.id ? 'border-primary bg-primary/10' : 'border-base-300 hover:bg-base-200/50'}`}
					>
						<p class="font-medium">{wing.name}</p>
						<p class="text-xs text-base-content/60">{wing.rooms.length} rooms</p>
					</button>
				{/each}
			</div>

			<h2 class="mb-2 mt-4 text-sm font-semibold text-base-content/70">Dreaming Sessions</h2>
			<div class="space-y-2 overflow-y-auto">
				{#if dreamingSessions.length === 0}
					<p class="text-xs text-base-content/50">No Dreaming Agent sessions yet.</p>
				{:else}
					{#each dreamingSessions.slice(0, 6) as session (session.id)}
						<a class="block rounded-lg border border-base-300 px-2 py-2 text-xs hover:bg-base-200/50" href={`/chat/${session.id}`}>
							<p class="truncate font-medium">{session.title}</p>
							<p class="text-base-content/60">{new Date(session.updatedAt).toLocaleString()}</p>
						</a>
					{/each}
				{/if}
			</div>
		</section>

		<section class="min-h-0 rounded-2xl border border-base-300 bg-base-100 p-3">
			<h2 class="mb-2 text-sm font-semibold text-base-content/70">Rooms</h2>
			{#if !selectedWing}
				<p class="text-xs text-base-content/50">Select a wing.</p>
			{:else if selectedWing.rooms.length === 0}
				<p class="text-xs text-base-content/50">No rooms in this wing yet.</p>
			{:else}
				<div class="space-y-2 overflow-y-auto">
					{#each selectedWing.rooms as room (room.id)}
						<button
							type="button"
							onclick={() => (selectedRoomId = room.id)}
							class={`w-full rounded-xl border px-3 py-2 text-left ${selectedRoomId === room.id ? 'border-primary bg-primary/10' : 'border-base-300 hover:bg-base-200/50'}`}
						>
							<div class="flex items-center justify-between gap-2">
								<p class="font-medium">{room.name}</p>
								{#if room.isCloset}
									<span class="badge badge-sm">Closet</span>
								{/if}
							</div>
							<p class="text-xs text-base-content/60 line-clamp-2">{room.description ?? 'No description'}</p>
							{#if (tunnelMap.get(room.name.trim().toLowerCase()) ?? 0) > 1}
								<p class="mt-1 text-[11px] text-primary">Tunnel linked across {(tunnelMap.get(room.name.trim().toLowerCase()) ?? 0) - 1} other wings</p>
							{/if}
						</button>
					{/each}
				</div>
			{/if}
		</section>

		<section class="min-h-0 rounded-2xl border border-base-300 bg-base-100 p-3">
			<div class="mb-3 flex flex-wrap items-center gap-2">
				<input class="input input-bordered input-sm flex-1" bind:value={search} placeholder="Search drawers..." />
				<select class="select select-bordered select-sm" bind:value={hallFilter}>
					<option value="all">All halls</option>
					<option value="facts">Facts</option>
					<option value="events">Events</option>
					<option value="discoveries">Discoveries</option>
					<option value="preferences">Preferences</option>
					<option value="advice">Advice</option>
				</select>
			</div>

			<h2 class="mb-2 text-sm font-semibold text-base-content/70">
				{selectedRoom ? `${selectedRoom.name} Drawers` : selectedWing ? `${selectedWing.name} Drawers` : 'Drawers'}
			</h2>

			{#if roomMemories.length === 0}
				<p class="text-xs text-base-content/50">No drawers matched this view.</p>
			{:else}
				<div class="space-y-2 overflow-y-auto">
					{#each roomMemories as memory (memory.id)}
						<a class="block rounded-lg border border-base-300 px-3 py-2 hover:bg-base-200/50" href={`/memory/${memory.id}`}>
							<p class="line-clamp-2 text-sm">{memory.content}</p>
							<p class="mt-1 text-xs text-base-content/60">
								{memory.hallType} • {memory.category} • imp {Number(memory.importance).toFixed(2)}
							</p>
						</a>
					{/each}
				</div>
			{/if}
		</section>
	</div>
</div>

{#if showImportModal}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-base-content/35 p-3">
		<section class="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-base-300 bg-base-100 p-4 shadow-xl">
			<div class="flex items-start justify-between gap-3">
				<div>
					<h2 class="text-lg font-semibold">Manual Memory Import</h2>
					<p class="text-xs text-base-content/70">Paste notes, conversation logs, or summaries and extract memory drawers.</p>
				</div>
				<button
					type="button"
					class="btn btn-sm btn-ghost"
					onclick={() => {
						showImportModal = false;
						resetImportModal();
					}}
				>
					Close
				</button>
			</div>

			<div class="mt-3 space-y-3">
				<div>
					<label for="memory-import-model" class="mb-1 block text-xs font-semibold uppercase tracking-wide text-base-content/60">Model override (optional)</label>
					<input id="memory-import-model" class="input input-bordered input-sm w-full" bind:value={importModel} placeholder="anthropic/claude-sonnet-4" />
				</div>

				<div>
					<div class="mb-1 flex items-center justify-between gap-2">
						<label for="memory-import-text" class="text-xs font-semibold uppercase tracking-wide text-base-content/60">Import text</label>
						<button type="button" class="btn btn-xs btn-outline" onclick={generateImportPrompt}>Generate import prompt</button>
					</div>
					<textarea id="memory-import-text" class="textarea textarea-bordered min-h-55 w-full" bind:value={importText} placeholder="Paste memory source text here..."></textarea>
				</div>

				{#if importPrompt}
					<div class="rounded-xl border border-base-300 bg-base-200/40 p-3">
						<p class="text-[11px] font-semibold uppercase tracking-wide text-base-content/60">Suggested prompt</p>
						<pre class="mt-1 whitespace-pre-wrap text-xs leading-5 text-base-content/80">{importPrompt}</pre>
					</div>
				{/if}

				{#if importError}
					<p class="rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">{importError}</p>
				{/if}

				{#if importResult}
					<p class="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-xs text-success">
						Imported {importResult.extractedCount ?? 0} memories. Skipped duplicates: {importResult.duplicateCount ?? 0}.
					</p>
				{/if}

				<div class="flex justify-end gap-2">
					<button type="button" class="btn btn-sm btn-ghost" onclick={() => (importText = '')} disabled={importBusy}>Clear</button>
					<button type="button" class="btn btn-sm btn-primary" onclick={runImport} disabled={importBusy || !importText.trim()}>
						{importBusy ? 'Importing...' : 'Import Memories'}
					</button>
				</div>
			</div>
		</section>
	</div>
{/if}


