<svelte:head><title>Tasks | AgentStudio</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import { listTasksQuery } from '$lib/tasks/tasks.remote';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';

	type TaskRow = Awaited<ReturnType<typeof listTasksQuery>>[number];
	type Status = TaskRow['status'];

	const KANBAN_COLUMNS: Array<{ key: Status; label: string; tone: string }> = [
		{ key: 'pending', label: 'Pending', tone: 'badge-ghost' },
		{ key: 'planning', label: 'Planning', tone: 'badge-info' },
		{ key: 'awaiting_approval', label: 'Awaiting approval', tone: 'badge-warning' },
		{ key: 'running', label: 'Running', tone: 'badge-primary' },
		{ key: 'blocked', label: 'Blocked', tone: 'badge-error' },
		{ key: 'completed', label: 'Completed', tone: 'badge-success' },
		{ key: 'failed', label: 'Failed', tone: 'badge-error' },
		{ key: 'canceled', label: 'Canceled', tone: 'badge-ghost' },
	];

	let tasks = $state<TaskRow[]>([]);
	let loading = $state(false);
	let showTerminal = $state(true);
	let onlyTopLevel = $state(true);

	onMount(() => {
		void load();
	});

	async function load() {
		loading = true;
		try {
			tasks = await listTasksQuery({
				includeTerminal: showTerminal,
				parentTaskId: onlyTopLevel ? null : undefined,
			});
		} finally {
			loading = false;
		}
	}

	function tasksFor(status: Status) {
		return tasks.filter((t) => t.status === status);
	}

	function fmtRelative(iso: Date | string | null | undefined) {
		if (!iso) return '';
		const ts = new Date(iso).getTime();
		const diffSec = Math.floor((Date.now() - ts) / 1000);
		if (diffSec < 60) return 'just now';
		if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
		if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
		return `${Math.floor(diffSec / 86400)}d ago`;
	}

	async function refresh() {
		await load();
	}
</script>

<div class="flex h-full min-h-0 flex-col space-y-3 sm:space-y-4">
	<ContentPanel>
		{#snippet header()}
			<div class="flex flex-1 flex-wrap items-center justify-between gap-2">
				<div>
					<h1 class="text-xl font-bold sm:text-3xl">Tasks</h1>
					<p class="text-xs text-base-content/70 sm:text-sm">
						{tasks.length} task{tasks.length === 1 ? '' : 's'} · approved plans materialize here
					</p>
				</div>
				<div class="flex items-center gap-3">
					<label class="flex cursor-pointer items-center gap-2 text-xs">
						<input
							type="checkbox"
							class="toggle toggle-xs"
							checked={onlyTopLevel}
							onchange={(e) => {
								onlyTopLevel = (e.currentTarget as HTMLInputElement).checked;
								void load();
							}}
						/>
						<span>Top-level only</span>
					</label>
					<label class="flex cursor-pointer items-center gap-2 text-xs">
						<input
							type="checkbox"
							class="toggle toggle-xs"
							checked={showTerminal}
							onchange={(e) => {
								showTerminal = (e.currentTarget as HTMLInputElement).checked;
								void load();
							}}
						/>
						<span>Include terminal</span>
					</label>
					<button class="btn btn-ghost btn-xs" type="button" onclick={refresh} disabled={loading}>
						{loading ? 'Loading…' : 'Refresh'}
					</button>
				</div>
			</div>
		{/snippet}
	</ContentPanel>

	<div class="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
		<div class="flex h-full min-w-max gap-3 px-1 pb-2">
			{#each KANBAN_COLUMNS as column (column.key)}
				{@const items = tasksFor(column.key)}
				<div class="flex w-72 flex-col rounded-2xl border border-base-300/60 bg-base-200/30">
					<header class="flex shrink-0 items-center justify-between gap-2 border-b border-base-300/60 px-3 py-2">
						<div class="flex items-center gap-2">
							<span class="badge badge-sm {column.tone}">{column.label}</span>
						</div>
						<span class="font-mono text-xs tabular-nums text-base-content/55">{items.length}</span>
					</header>
					<div class="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
						{#if items.length === 0}
							<p class="px-2 py-3 text-center text-xs italic text-base-content/35">No tasks</p>
						{:else}
							{#each items as task (task.id)}
								<a
									href="/tasks/{task.id}"
									class="block rounded-xl border border-base-300/60 bg-base-100/95 p-3 text-sm shadow-sm transition-colors hover:border-base-content/30"
								>
									<p class="line-clamp-2 font-medium leading-snug">{task.title}</p>
									<div class="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-base-content/55">
										{#if task.childCount > 0}
											<span class="badge badge-xs badge-outline">{task.childCount} step{task.childCount === 1 ? '' : 's'}</span>
										{/if}
										{#if task.priority > 0}
											<span class="badge badge-xs badge-ghost">P{task.priority}</span>
										{/if}
										{#if task.budgetUsd}
											<span class="font-mono tabular-nums">${parseFloat(task.budgetUsd).toFixed(2)}</span>
										{/if}
										<span class="ml-auto">{fmtRelative(task.updatedAt)}</span>
									</div>
								</a>
							{/each}
						{/if}
					</div>
				</div>
			{/each}
		</div>
	</div>
</div>
