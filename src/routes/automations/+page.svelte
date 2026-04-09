<svelte:head><title>Automations | AgentStudio</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import { listAutomationsQuery } from '$lib/automation';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';

	type AutomationRow = Awaited<ReturnType<typeof listAutomationsQuery>>[number];

	let rows = $state<AutomationRow[]>([]);

	onMount(() => {
		void loadAutomations();
	});

	async function loadAutomations() {
		rows = await listAutomationsQuery();
	}
</script>

<ContentPanel>
	{#snippet header()}
		<div>
			<h1 class="text-2xl font-bold">Automations</h1>
			<p class="text-sm text-base-content/70">Scheduled and recurring agent workflows ({rows.length})</p>
		</div>
	{/snippet}

	{#if rows.length === 0}
		<div class="rounded-2xl border border-base-300 bg-base-100 p-6 text-center text-sm text-base-content/60">
			No automations configured yet.
		</div>
	{:else}
		<div class="space-y-3">
			{#each rows as automation (automation.id)}
				<article class="rounded-2xl border border-base-300 bg-base-100 p-4">
					<div class="flex flex-wrap items-start justify-between gap-2">
						<div class="space-y-1">
							<h2 class="font-semibold">{automation.description}</h2>
							<p class="text-xs text-base-content/60">
								Agent: {automation.agentName ?? 'Orchestrator'}
								&middot; Mode: {automation.conversationMode}
							</p>
							<p class="text-xs text-base-content/60">Cron: {automation.cronExpression}</p>
						</div>
						<span class={`badge ${automation.enabled ? 'badge-success' : 'badge-ghost'}`}>
							{automation.enabled ? 'enabled' : 'disabled'}
						</span>
					</div>
					<p class="mt-3 line-clamp-2 text-sm text-base-content/80">{automation.prompt}</p>
					<div class="mt-3 flex flex-wrap gap-3 text-xs text-base-content/60">
						<span>Next: {automation.nextRunAt ? new Date(automation.nextRunAt).toLocaleString() : 'unscheduled'}</span>
						<span>Last: {automation.lastRunAt ? new Date(automation.lastRunAt).toLocaleString() : 'never'}</span>
						{#if automation.conversationId}
							<a class="link link-primary" href={`/chat/${automation.conversationId}`}>Conversation</a>
						{/if}
					</div>
				</article>
			{/each}
		</div>
	{/if}
</ContentPanel>
