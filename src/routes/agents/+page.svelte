<svelte:head><title>Agents | DrokBot</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import {
		listAgents,
		previewQueue,
		runSchedulerDrainCommand,
		runSchedulerTickCommand,
		schedulerSnapshot,
		updateAgentStatus
	} from '$lib/agents';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';

	type AgentRow = Awaited<ReturnType<typeof listAgents>>[number];
	type Snapshot = Awaited<ReturnType<typeof schedulerSnapshot>>;
	type QueuePreview = Awaited<ReturnType<typeof previewQueue>>[number];

	let agents = $state<AgentRow[]>([]);
	let snapshot = $state<Snapshot | null>(null);
	let queuePreview = $state<QueuePreview[]>([]);
	let busy = $state(false);

	onMount(() => {
		void refresh();
	});

	async function refresh() {
		const [agentRows, scheduler, queueRows] = await Promise.all([listAgents(), schedulerSnapshot(), previewQueue()]);
		agents = agentRows;
		snapshot = scheduler;
		queuePreview = queueRows;
	}

	async function setStatus(agentId: string, status: 'active' | 'paused' | 'idle') {
		await updateAgentStatus({ agentId, status });
		await refresh();
	}

	async function runTick() {
		if (busy) return;
		busy = true;
		try {
			await runSchedulerTickCommand({ maxConcurrent: 2 });
			await refresh();
		} finally {
			busy = false;
		}
	}

	async function runDrain() {
		if (busy) return;
		busy = true;
		try {
			await runSchedulerDrainCommand({ maxConcurrent: 2, maxTicks: 12 });
			await refresh();
		} finally {
			busy = false;
		}
	}
</script>

<section class="space-y-4">
	<ContentPanel>
		{#snippet header()}
			<div>
				<h1 class="text-xl font-bold sm:text-3xl">Agents</h1>
				<p class="text-xs text-base-content/70 sm:text-sm">Manage lifecycle and scheduling for autonomous workers.</p>
			</div>
		{/snippet}
		{#snippet actions()}
			<button class="btn btn-sm btn-outline sm:btn-md" type="button" onclick={runTick} disabled={busy}>Tick</button>
			<button class="btn btn-sm btn-outline sm:btn-md" type="button" onclick={runDrain} disabled={busy}>Drain</button>
			<a class="btn btn-sm btn-primary sm:btn-md" href="/agents/new">New Agent</a>
		{/snippet}
	</ContentPanel>

	{#if snapshot}
		<div class="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 lg:grid-cols-6">
			<div class="rounded-lg border border-base-300 bg-base-100 p-2 text-xs sm:rounded-xl sm:p-3 sm:text-sm">Open runs: {snapshot.openRuns}</div>
			<div class="rounded-lg border border-base-300 bg-base-100 p-2 text-xs sm:rounded-xl sm:p-3 sm:text-sm">Active: {snapshot.agents.active}</div>
			<div class="rounded-lg border border-base-300 bg-base-100 p-2 text-xs sm:rounded-xl sm:p-3 sm:text-sm">Idle: {snapshot.agents.idle}</div>
			<div class="rounded-lg border border-base-300 bg-base-100 p-2 text-xs sm:rounded-xl sm:p-3 sm:text-sm">Pending: {snapshot.queue.pending}</div>
			<div class="rounded-lg border border-base-300 bg-base-100 p-2 text-xs sm:rounded-xl sm:p-3 sm:text-sm">Running: {snapshot.queue.running}</div>
			<div class="rounded-lg border border-base-300 bg-base-100 p-2 text-xs sm:rounded-xl sm:p-3 sm:text-sm">Review: {snapshot.queue.review}</div>
			<div class="rounded-lg border border-base-300 bg-base-100 p-2 text-xs sm:rounded-xl sm:p-3 sm:text-sm">Failed: {snapshot.queue.failed}</div>
		</div>
	{/if}

	<ContentPanel>
		{#snippet header()}<h2 class="text-sm font-semibold uppercase tracking-wide text-base-content/60">Pending Queue</h2>{/snippet}
		{#if queuePreview.length === 0}
			<p class="text-sm text-base-content/70">No pending tasks.</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="table table-sm">
					<thead>
						<tr>
							<th>Title</th>
							<th>Priority</th>
							<th>Agent</th>
						</tr>
					</thead>
					<tbody>
						{#each queuePreview as queued (queued.id)}
							<tr>
								<td>{queued.title}</td>
								<td>{queued.priority}</td>
								<td>{queued.agentId.slice(0, 8)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
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
					<p class="mt-3 text-xs text-base-content/70">
						pending {agent.pendingCount} | running {agent.runningCount} | review {agent.reviewCount}
					</p>
					<div class="mt-3 flex flex-wrap gap-1">
						<a class="btn btn-xs btn-outline" href={`/agents/${agent.id}`}>Open</a>
						<button class="btn btn-xs" type="button" onclick={() => setStatus(agent.id, 'active')}>Activate</button>
						<button class="btn btn-xs" type="button" onclick={() => setStatus(agent.id, 'idle')}>Idle</button>
						<button class="btn btn-xs btn-warning" type="button" onclick={() => setStatus(agent.id, 'paused')}>Pause</button>
					</div>
				</article>
			{/each}
		{/if}
	</div>
</section>

