<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { listAgentRuns } from '$lib/agents/runs.remote';
	import { getAgent } from '$lib/agents/agents.remote';

	const agentId = $derived(page.params.id ?? '');

	type AgentData = Awaited<ReturnType<typeof getAgent>>;
	type RunRow = Awaited<ReturnType<typeof listAgentRuns>>[number];

	let agentData = $state<AgentData | null>(null);
	let runs = $state<RunRow[]>([]);

	onMount(() => {
		void refresh();
	});

	async function refresh() {
		if (!agentId) return;
		const [agent, runRows] = await Promise.all([getAgent(agentId), listAgentRuns({ agentId })]);
		agentData = agent;
		runs = runRows;
	}

	function duration(start: string | Date, end: string | Date | null): string {
		if (!end) return 'running…';
		const ms = new Date(end).getTime() - new Date(start).getTime();
		if (ms < 1000) return `${ms}ms`;
		return `${(ms / 1000).toFixed(1)}s`;
	}

	function fmt(val: string | number): string {
		return `$${Number(val).toFixed(4)}`;
	}
</script>

<section class="space-y-4">
	<div class="flex items-center gap-2">
		<a class="btn btn-sm btn-ghost" href="/agents/{agentId}">Back to agent</a>
	</div>

	<header class="rounded-2xl border border-base-300 bg-base-100 p-4">
		<h1 class="text-2xl font-bold">Run History</h1>
		{#if agentData}
			<p class="text-sm text-base-content/70">{agentData.agent.name} — {agentData.agent.role}</p>
		{/if}
		<p class="text-xs text-base-content/60">{runs.length} runs</p>
	</header>

	{#if runs.length === 0}
		<p class="text-sm text-base-content/70">No runs yet.</p>
	{:else}
		<div class="space-y-2">
			{#each runs as run (run.id)}
				<a
					href="/agents/{agentId}/runs/{run.id}"
					class="flex items-center justify-between rounded-2xl border border-base-300 bg-base-100 p-4 hover:bg-base-200/50"
				>
					<div>
						<p class="font-medium">{run.taskTitle ?? 'Untitled task'}</p>
						<p class="text-xs text-base-content/70">
							{new Date(run.startedAt).toLocaleString()} · {duration(run.startedAt, run.endedAt)}
						</p>
						{#if run.taskStatus}
							<span class="badge badge-sm mt-1">{run.taskStatus}</span>
						{/if}
					</div>
					<div class="text-right">
						<p class="font-mono text-sm">{fmt(run.cost)}</p>
						<p class="text-xs text-base-content/70">{run.id.slice(0, 8)}</p>
					</div>
				</a>
			{/each}
		</div>
	{/if}
</section>
