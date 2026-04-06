<svelte:head><title>Tasks | DrokBot</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import { getAgentChoices, runSchedulerTickCommand } from '$lib/agents';
	import { listTasks, setTaskPriority, setTaskStatus } from '$lib/tasks';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';

	type TaskRow = Awaited<ReturnType<typeof listTasks>>[number];
	type AgentChoice = Awaited<ReturnType<typeof getAgentChoices>>[number];

	let tasks = $state<TaskRow[]>([]);
	let agents = $state<AgentChoice[]>([]);
	let busy = $state(false);

	const columns: Array<TaskRow['status']> = ['pending', 'running', 'review', 'changes_requested', 'completed', 'failed'];

	onMount(() => {
		void refresh();
	});

	async function refresh() {
		const [taskRows, agentRows] = await Promise.all([listTasks({ limit: 250 }), getAgentChoices()]);
		tasks = taskRows;
		agents = agentRows;
	}

	function byStatus(status: TaskRow['status']) {
		return tasks.filter((task) => task.status === status);
	}

	async function moveTask(taskId: string, status: TaskRow['status']) {
		await setTaskStatus({ taskId, status });
		await refresh();
	}

	async function updatePriority(taskId: string, next: number) {
		await setTaskPriority({ taskId, priority: Math.max(0, Math.min(5, next)) });
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
</script>

<section class="space-y-3 sm:space-y-4">
	<ContentPanel>
		{#snippet header()}
			<div>
				<h1 class="text-xl font-bold sm:text-3xl">Tasks</h1>
				<p class="text-xs text-base-content/70 sm:text-sm">Kanban view for agent work queue and review stages.</p>
			</div>
		{/snippet}
		{#snippet actions()}
			<span class="text-xs text-base-content/70">agents {agents.length}</span>
			<button class="btn btn-sm btn-outline sm:btn-md" type="button" onclick={runTick} disabled={busy}>Run Tick</button>
		{/snippet}
	</ContentPanel>

	<div class="-mx-2 flex gap-3 overflow-x-auto px-2 pb-2 sm:mx-0 sm:px-0 sm:pb-0 xl:grid xl:grid-cols-6 xl:overflow-visible">
		{#each columns as status (status)}
			<section class="min-w-[200px] flex-shrink-0 rounded-2xl border border-base-300 bg-base-100 p-2 sm:min-w-0 sm:p-3 xl:flex-shrink">
				<h2 class="mb-2 text-xs font-semibold uppercase tracking-wide sm:text-sm">{status}</h2>
				<div class="space-y-2">
					{#if byStatus(status).length === 0}
						<p class="text-xs text-base-content/60">No tasks</p>
					{:else}
						{#each byStatus(status) as task (task.id)}
							<article class="rounded-xl border border-base-300 p-2 text-sm sm:p-3">
								<a class="font-medium hover:underline" href={`/tasks/${task.id}`}>{task.title}</a>
								<p class="text-xs text-base-content/70">{task.agentName}</p>
								<p class="text-xs text-base-content/70">priority {task.priority}</p>
								<div class="mt-1.5 flex flex-wrap gap-1 sm:mt-2">
									<button class="btn btn-xs" type="button" onclick={() => updatePriority(task.id, task.priority + 1)}>P+</button>
									<button class="btn btn-xs" type="button" onclick={() => updatePriority(task.id, task.priority - 1)}>P-</button>
									{#if status !== 'pending'}
										<button class="btn btn-xs" type="button" onclick={() => moveTask(task.id, 'pending')}>Pending</button>
									{/if}
									{#if status !== 'review'}
										<button class="btn btn-xs" type="button" onclick={() => moveTask(task.id, 'review')}>Review</button>
									{/if}
									{#if status !== 'completed'}
										<button class="btn btn-xs" type="button" onclick={() => moveTask(task.id, 'completed')}>Done</button>
									{/if}
									{#if status !== 'failed'}
										<button class="btn btn-xs btn-error btn-outline" type="button" onclick={() => moveTask(task.id, 'failed')}>Fail</button>
									{/if}
								</div>
							</article>
						{/each}
					{/if}
				</div>
			</section>
		{/each}
	</div>
</section>

