<svelte:head><title>{data?.agent.name ?? 'Agent'} | DrokBot</title></svelte:head>

<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { createTask, delegateTask, getAgent, getAgentChoices, runTaskNow, updateAgentStatus } from '$lib/agents/agents.remote';

	const agentId = $derived(page.params.id ?? '');
	let data = $state<Awaited<ReturnType<typeof getAgent>> | null>(null);
	let agentChoices = $state<Awaited<ReturnType<typeof getAgentChoices>>>([]);
	let title = $state('');
	let description = $state('');
	let delegateAgentId = $state('');
	let delegateTaskText = $state('');
	let busy = $state(false);

	onMount(() => {
		void refresh();
	});

	async function refresh() {
		if (!agentId) return;
		const [agentData, choices] = await Promise.all([getAgent(agentId), getAgentChoices()]);
		data = agentData;
		const filtered = choices.filter((choice) => choice.id !== agentId);
		agentChoices = filtered;
		if (!delegateAgentId && filtered.length > 0) {
			delegateAgentId = filtered[0].id;
		}
	}

	async function changeStatus(status: 'active' | 'paused' | 'idle') {
		if (!agentId) return;
		await updateAgentStatus({ agentId, status });
		await refresh();
	}

	async function createAgentTaskAction() {
		if (!agentId || !title.trim() || !description.trim()) return;
		busy = true;
		try {
			await createTask({
				agentId,
				title: title.trim(),
				description: description.trim(),
				priority: 2,
			});
			title = '';
			description = '';
			await refresh();
		} finally {
			busy = false;
		}
	}

	async function runTask(taskId: string) {
		if (busy) return;
		busy = true;
		try {
			await runTaskNow({ taskId });
			await refresh();
		} finally {
			busy = false;
		}
	}

	async function delegateTaskAction() {
		if (!delegateAgentId || !delegateTaskText.trim() || busy) return;
		busy = true;
		try {
			await delegateTask({
				agentId: delegateAgentId,
				task: delegateTaskText.trim(),
			});
			delegateTaskText = '';
			await refresh();
		} finally {
			busy = false;
		}
	}
</script>

{#if !data}
	<p class="text-sm text-base-content/70">Agent not found.</p>
{:else}
	<section class="space-y-4">
		<a class="btn btn-sm btn-ghost" href="/agents">Back to agents</a>
		<header class="rounded-2xl border border-base-300 bg-base-100 p-4">
			<div class="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h1 class="text-2xl font-bold">{data.agent.name}</h1>
					<p class="text-sm text-base-content/70">{data.agent.role}</p>
				</div>
				<div class="flex flex-wrap gap-1">
					<button class="btn btn-xs" type="button" onclick={() => changeStatus('active')}>Activate</button>
					<button class="btn btn-xs" type="button" onclick={() => changeStatus('idle')}>Idle</button>
					<button class="btn btn-xs btn-warning" type="button" onclick={() => changeStatus('paused')}>Pause</button>
					<a class="btn btn-xs btn-outline" href="/agents/{agentId}/runs">Run History</a>
				</div>
			</div>
			<p class="mt-2 text-xs text-base-content/70">Status: {data.agent.status}</p>
		</header>

		<section class="rounded-2xl border border-base-300 bg-base-100 p-4">
			<h2 class="font-semibold">Create Task</h2>
			<div class="mt-2 grid gap-2">
				<input class="input input-bordered" bind:value={title} placeholder="Task title" />
				<textarea class="textarea textarea-bordered h-24" bind:value={description} placeholder="Task details"></textarea>
				<button class="btn btn-primary" type="button" onclick={createAgentTaskAction} disabled={busy}>Queue Task</button>
			</div>
		</section>

		<section class="rounded-2xl border border-base-300 bg-base-100 p-4">
			<h2 class="font-semibold">Delegate Task To Another Agent</h2>
			<div class="mt-2 grid gap-2">
				<select class="select select-bordered" bind:value={delegateAgentId}>
					{#if agentChoices.length === 0}
						<option value="">No other agents available</option>
					{:else}
						{#each agentChoices as choice (choice.id)}
							<option value={choice.id}>{choice.name} ({choice.status})</option>
						{/each}
					{/if}
				</select>
				<textarea class="textarea textarea-bordered h-24" bind:value={delegateTaskText} placeholder="Delegated task details"></textarea>
				<button class="btn btn-outline" type="button" onclick={delegateTaskAction} disabled={busy || agentChoices.length === 0}>
					Delegate
				</button>
			</div>
		</section>

		<section class="grid gap-4 lg:grid-cols-2">
			<div class="rounded-2xl border border-base-300 bg-base-100 p-4">
				<h2 class="font-semibold">Tasks</h2>
				<div class="mt-2 space-y-2">
					{#if data.tasks.length === 0}
						<p class="text-sm text-base-content/70">No tasks yet.</p>
					{:else}
						{#each data.tasks as task (task.id)}
							<article class="rounded-xl border border-base-300 p-3 text-sm">
								<div class="flex items-start justify-between gap-2">
									<div>
										<p class="font-medium">{task.title}</p>
										<p class="text-xs text-base-content/70">{task.status} | p{task.priority}</p>
										{#if typeof task.result === 'object' && task.result && 'summary' in task.result}
											<p class="mt-1 line-clamp-3 text-xs text-base-content/70">{String(task.result.summary)}</p>
										{/if}
									</div>
									{#if task.status === 'pending'}
										<button class="btn btn-xs" type="button" onclick={() => runTask(task.id)}>Run</button>
									{/if}
								</div>
							</article>
						{/each}
					{/if}
				</div>
			</div>

			<div class="rounded-2xl border border-base-300 bg-base-100 p-4">
				<h2 class="font-semibold">Run History</h2>
				<div class="mt-2 space-y-2">
					{#if data.runs.length === 0}
						<p class="text-sm text-base-content/70">No runs yet.</p>
					{:else}
						{#each data.runs as run (run.id)}
							<article class="rounded-xl border border-base-300 p-3 text-sm">
								<p class="font-medium">Run {run.id.slice(0, 8)}</p>
								<p class="text-xs text-base-content/70">
									{new Date(run.startedAt).toLocaleString()} to
									{run.endedAt ? new Date(run.endedAt).toLocaleString() : 'in progress'}
								</p>
							</article>
						{/each}
					{/if}
				</div>
			</div>
		</section>
	</section>
{/if}
