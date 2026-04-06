<script lang="ts">
	import { onMount } from 'svelte';
	import { listDreamCyclesQuery, runDreamCycleCommand } from '$lib/memory';
	import { listMemoriesQuery } from '$lib/memory';

	type DreamRow = Awaited<ReturnType<typeof listDreamCyclesQuery>>[number];

	let busy = $state(false);
	let dreamCycles = $state<DreamRow[]>([]);

	onMount(() => {
		void loadDreamCycles();
	});

	async function loadDreamCycles() {
		dreamCycles = await listDreamCyclesQuery({ limit: 8 });
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
			await loadDreamCycles();
		} finally {
			busy = false;
		}
	}
</script>

<div class="w-full space-y-2 pb-3">
	<div class="flex items-center justify-between">
		<h2 class="text-xl font-bold sm:text-3xl">Dream Cycles</h2>
		<button class="btn btn-primary btn-sm btn-outline" type="button" onclick={handleRunDreamCycle} disabled={busy}>
			{#if busy}
				<span class="loading loading-spinner loading-xs"></span>
			{/if}
			Run
		</button>
	</div>
	<p class="text-xs text-base-content/70 sm:text-sm">Consolidate, decay, and prune memories.</p>
</div>

<div class="mt-3 space-y-2">
	{#if dreamCycles.length === 0}
		<p class="py-4 text-center text-xs text-base-content/40">No dream cycles yet.</p>
	{:else}
		{#each dreamCycles as cycle (cycle.id)}
			<div class="rounded-xl px-2.5 py-2 transition-colors hover:bg-base-200">
				<div class="flex items-center justify-between gap-2">
					<p class="text-sm font-medium">{new Date(cycle.startedAt).toLocaleDateString()}</p>
					<div class="flex items-center gap-2 text-xs">
						<span class="rounded-md bg-success/10 px-1.5 py-0.5 text-success">+{cycle.memoriesCreated}</span>
						<span class="rounded-md bg-error/10 px-1.5 py-0.5 text-error">-{cycle.memoriesPruned}</span>
					</div>
				</div>
				<p class="mt-1 text-xs text-base-content/50">{cycle.summary ?? 'No summary'}</p>
			</div>
		{/each}
	{/if}
</div>
