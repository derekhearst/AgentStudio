<svelte:head><title>Run Detail | DrokBot</title></svelte:head>

<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { getAgentRun } from '$lib/agents';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';

	const agentId = $derived(page.params.id ?? '');
	const runId = $derived(page.params.runId ?? '');

	type RunDetail = Awaited<ReturnType<typeof getAgentRun>>;

	let data = $state<RunDetail | null>(null);

	onMount(() => {
		void refresh();
	});

	async function refresh() {
		if (!runId) return;
		data = await getAgentRun(runId);
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

	type LogEntry = {
		timestamp?: string;
		event?: string;
		[key: string]: unknown;
	};
</script>

{#if !data}
	<div class="flex justify-center p-8"><span class="loading loading-spinner loading-lg"></span></div>
{:else}
	<section class="space-y-4">
		<div class="flex items-center gap-2">
			<a class="btn btn-sm btn-ghost" href="/agents/{agentId}/runs">Back to runs</a>
			{#if data.task}
				<a class="btn btn-sm btn-ghost" href="/tasks/{data.task.id}">View task</a>
			{/if}
		</div>

		<!-- Run Header -->
		<ContentPanel>
			{#snippet header()}
				<div>
					<h1 class="text-2xl font-bold">Run Trace</h1>
					<div class="mt-2 grid gap-1 text-sm">
						<p>
							<span class="text-base-content/55">Agent:</span>
							{data?.agent?.name ?? 'Unknown'} ({data?.agent?.model ?? 'unknown model'})
						</p>
						{#if data?.task}
							<p><span class="text-base-content/55">Task:</span> {data.task.title}</p>
							<p><span class="text-base-content/55">Status:</span> <span class="badge badge-sm">{data.task.status}</span></p>
						{/if}
						<p>
							<span class="text-base-content/55">Duration:</span>
							{duration(data?.run.startedAt ?? new Date(), data?.run.endedAt ?? new Date())}
						</p>
						<p><span class="text-base-content/55">Cost:</span> {fmt(data?.run.cost ?? 0)}</p>
					</div>
				</div>
			{/snippet}
		</ContentPanel>

		<!-- Execution Timeline -->
		<ContentPanel>
			{#snippet header()}<h2 class="font-semibold">Execution Timeline</h2>{/snippet}
			<div>
				{#if data.run.logs && Array.isArray(data.run.logs) && data.run.logs.length > 0}
					<ul class="timeline timeline-vertical timeline-compact">
						{#each data.run.logs as log, i}
							{@const entry = log as LogEntry}
							<li>
								{#if i > 0}<hr />{/if}
								<div class="timeline-start text-xs text-base-content/55">
									{entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : ''}
								</div>
								<div class="timeline-middle">
									<div
										class="h-3 w-3 rounded-full"
										class:bg-success={entry.event === 'task_completed'}
										class:bg-error={entry.event === 'task_failed'}
										class:bg-info={entry.event === 'task_started'}
										class:bg-base-300={!entry.event}
									></div>
								</div>
								<div class="timeline-end rounded-lg border border-base-300 bg-base-50 p-3">
									<p class="font-medium text-sm">{entry.event ?? 'log'}</p>
									{#if entry.preview}
										<p class="mt-1 text-xs text-base-content/70 line-clamp-3">{entry.preview}</p>
									{/if}
									{#if entry.error}
										<p class="mt-1 text-xs text-error">{entry.error}</p>
									{/if}
									{#if entry.toolCalls != null}
										<p class="text-xs text-base-content/60">{entry.toolCalls} tool calls</p>
									{/if}
									{#if entry.delegatedTaskId}
										<p class="text-xs text-base-content/60">
											Delegated →
											<a class="link" href="/tasks/{entry.delegatedTaskId}">{String(entry.delegatedTaskId).slice(0, 8)}</a>
										</p>
									{/if}
								</div>
								{#if i < (data?.run?.logs as unknown[]).length - 1}<hr />{/if}
							</li>
						{/each}
					</ul>
				{:else}
					<p class="text-sm text-base-content/70">No timeline entries.</p>
				{/if}
			</div>
		</ContentPanel>

		<!-- Tool Call Details -->
		{#if data.toolResults.length > 0}
			<ContentPanel>
				{#snippet header()}<h2 class="font-semibold">Tool Calls</h2>{/snippet}
				<div class="space-y-3">
					{#each data.toolResults as entry, i}
						<details class="collapse collapse-arrow rounded-xl border border-base-300">
							<summary class="collapse-title flex items-center gap-2 text-sm font-medium">
								<span class="badge badge-sm" class:badge-success={entry.result.success} class:badge-error={!entry.result.success}>
									{i + 1}
								</span>
								{entry.call.name}
								{#if entry.result.executionMs}
									<span class="text-xs text-base-content/55">{entry.result.executionMs}ms</span>
								{/if}
							</summary>
							<div class="collapse-content space-y-2">
								<div>
									<p class="text-xs font-semibold uppercase text-base-content/55">Input</p>
									<pre class="mt-1 max-h-40 overflow-auto rounded border border-base-300 bg-base-50 p-2 text-xs">{JSON.stringify(entry.call.arguments, null, 2)}</pre>
								</div>
								<div>
									<p class="text-xs font-semibold uppercase text-base-content/55">Output</p>
									<pre class="mt-1 max-h-40 overflow-auto rounded border border-base-300 bg-base-50 p-2 text-xs">{entry.result.output ?? entry.result.error ?? 'No output'}</pre>
								</div>
							</div>
						</details>
					{/each}
				</div>
			</ContentPanel>
		{/if}

		<!-- Token Usage -->
		<ContentPanel>
			{#snippet header()}<h2 class="font-semibold">Token Usage</h2>{/snippet}
			<pre class="max-h-60 overflow-auto rounded border border-base-300 bg-base-50 p-3 text-xs">{JSON.stringify(data.run.tokenUsage, null, 2)}</pre>
		</ContentPanel>

		<!-- Task Result -->
		{#if data.task?.result && typeof data.task.result === 'object'}
			<ContentPanel>
				{#snippet header()}<h2 class="font-semibold">Task Result</h2>{/snippet}
				<pre class="max-h-60 overflow-auto rounded border border-base-300 bg-base-50 p-3 text-xs">{JSON.stringify(data.task.result, null, 2)}</pre>
			</ContentPanel>
		{/if}
	</section>
{/if}

