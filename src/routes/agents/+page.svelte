<svelte:head><title>Agents | AgentStudio</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import { listAgents } from '$lib/agents';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';

	type AgentRow = Awaited<ReturnType<typeof listAgents>>[number];

	let agents = $state<AgentRow[]>([]);

	onMount(() => {
		void loadAgents();
	});

	async function loadAgents() {
		agents = await listAgents();
	}
</script>

<section class="space-y-4">
	<ContentPanel>
		{#snippet header()}
			<div>
				<h1 class="text-xl font-bold sm:text-3xl">Agents</h1>
				<p class="text-xs text-base-content/70 sm:text-sm">Autonomous workers managed by the orchestrator.</p>
			</div>
		{/snippet}
	</ContentPanel>

	<div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
		{#if agents.length === 0}
			<p class="text-sm text-base-content/70">No agents yet.</p>
		{:else}
			{#each agents as agent (agent.id)}
				<article class="rounded-2xl border border-base-300 bg-base-100 p-4">
					<div class="flex items-start justify-between gap-2">
						<div>
							<h2 class="font-semibold">{agent.name}</h2>
							<p class="text-xs text-base-content/60">{agent.role}</p>
						</div>
						<span class="badge">{agent.status}</span>
					</div>
					<div class="mt-3 rounded-xl border border-base-300/80 bg-base-200/40 p-3">
						<p class="text-[11px] font-semibold uppercase tracking-wide text-base-content/60">System Prompt</p>
						<p class="mt-1 whitespace-pre-wrap text-xs leading-5 text-base-content/80 line-clamp-6">{agent.systemPrompt}</p>
					</div>
					<div class="mt-3 flex flex-wrap gap-1">
						<a class="btn btn-xs btn-outline" href={`/agents/${agent.id}`}>Open</a>
					</div>
				</article>
			{/each}
		{/if}
	</div>
</section>

