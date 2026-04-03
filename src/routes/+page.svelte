<script lang="ts">
	import { onMount } from 'svelte';
	import { getDashboardSummary } from '$lib/dashboard/dashboard.remote';

	type DashboardSummary = Awaited<ReturnType<typeof getDashboardSummary>>;

	let summary = $state<DashboardSummary | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);

	onMount(() => {
		void load();
	});

	async function load() {
		loading = true;
		error = null;
		try {
			summary = await getDashboardSummary();
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Failed to load dashboard';
		} finally {
			loading = false;
		}
	}

	const metricCards = $derived(
		summary
			? [
					{ label: 'Conversations', value: summary.metrics.conversationCount, href: '/chat' },
					{ label: 'Messages', value: summary.metrics.messageCount, href: '/chat' },
					{ label: 'Agents', value: summary.metrics.agentCount, href: '/agents' },
					{ label: 'Tasks', value: summary.metrics.taskCount, href: '/tasks' },
					{ label: 'Memories', value: summary.metrics.memoryCount, href: '/memory' },
					{ label: 'Notifications', value: summary.metrics.notificationCount, href: '/settings' }
				]
			: []
	);
</script>

<section class="space-y-5">
	<header class="rounded-3xl border border-base-300 bg-base-100 p-5">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div>
				<h1 class="text-3xl font-bold">DrokBot Dashboard</h1>
				<p class="text-sm text-base-content/70">
					Live system snapshot for chat, agents, memory, and workflow queues.
				</p>
			</div>
			<button class="btn btn-outline" type="button" onclick={load} disabled={loading}>Refresh</button>
		</div>
	</header>

	{#if error}
		<p class="rounded-2xl border border-error/40 bg-error/10 p-3 text-sm text-error">{error}</p>
	{/if}

	<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
		{#if loading}
			{#each Array.from({ length: 6 }) as _, idx (`loading-${idx}`)}
				<div class="rounded-2xl border border-base-300 bg-base-100 p-4">
					<div class="skeleton h-4 w-24"></div>
					<div class="skeleton mt-3 h-8 w-16"></div>
				</div>
			{/each}
		{:else}
			{#each metricCards as card (card.label)}
				<a class="rounded-2xl border border-base-300 bg-base-100 p-4 transition hover:border-primary/40 hover:shadow" href={card.href}>
					<p class="text-sm text-base-content/70">{card.label}</p>
					<p class="mt-1 text-3xl font-bold">{card.value}</p>
				</a>
			{/each}
		{/if}
	</div>

	<div class="grid gap-4 xl:grid-cols-2">
		<section class="rounded-3xl border border-base-300 bg-base-100 p-4">
			<h2 class="text-lg font-semibold">Task Status</h2>
			<div class="mt-3 flex flex-wrap gap-2">
				{#if summary?.tasksByStatus.length}
					{#each summary.tasksByStatus as bucket (bucket.status)}
						<span class="badge badge-outline px-3 py-3 text-sm">
							{bucket.status}: {bucket.count}
						</span>
					{/each}
				{:else}
					<p class="text-sm text-base-content/70">No tasks yet.</p>
				{/if}
			</div>
		</section>

		<section class="rounded-3xl border border-base-300 bg-base-100 p-4">
			<h2 class="text-lg font-semibold">Recent Conversations</h2>
			<div class="mt-3 space-y-2">
				{#if summary?.recentConversations.length}
					{#each summary.recentConversations as conversation (conversation.id)}
						<a class="block rounded-2xl border border-base-300 bg-base-50 p-3 hover:border-primary/40" href={`/chat/${conversation.id}`}>
							<p class="font-medium">{conversation.title}</p>
							<p class="mt-1 text-xs text-base-content/70">
								{conversation.model} | tokens {conversation.totalTokens} | updated {new Date(conversation.updatedAt).toLocaleString()}
							</p>
						</a>
					{/each}
				{:else}
					<p class="text-sm text-base-content/70">No conversations yet.</p>
				{/if}
			</div>
		</section>
	</div>

	<section class="rounded-3xl border border-base-300 bg-base-100 p-4">
		<div class="flex items-center justify-between gap-3">
			<h2 class="text-lg font-semibold">Recent Tasks</h2>
			<a class="btn btn-sm btn-ghost" href="/tasks">Open Task Board</a>
		</div>
		<div class="mt-3 overflow-x-auto">
			<table class="table table-zebra">
				<thead>
					<tr>
						<th>Title</th>
						<th>Agent</th>
						<th>Status</th>
						<th>Priority</th>
						<th>Created</th>
					</tr>
				</thead>
				<tbody>
					{#if summary?.recentTasks.length}
						{#each summary.recentTasks as task (task.id)}
							<tr>
								<td>
									<a class="link link-hover" href={`/tasks/${task.id}`}>{task.title}</a>
								</td>
								<td>{task.agentName ?? 'Unknown agent'}</td>
								<td><span class="badge badge-outline">{task.status}</span></td>
								<td>{task.priority}</td>
								<td>{new Date(task.createdAt).toLocaleString()}</td>
							</tr>
						{/each}
					{:else}
						<tr>
							<td colspan="5" class="text-sm text-base-content/70">No tasks yet.</td>
						</tr>
					{/if}
				</tbody>
			</table>
		</div>
	</section>
</section>
