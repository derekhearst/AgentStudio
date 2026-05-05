<svelte:head><title>{detail?.task.title ?? 'Task'} | AgentStudio</title></svelte:head>

<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import {
		getTaskByIdQuery,
		getTaskSubtreeQuery,
		setTaskStatusCommand,
		cancelTaskCommand,
		retryTaskCommand,
		setTaskRepositoryCommand,
		listConnectedRepositoriesQuery,
	} from '$lib/tasks/tasks.remote';
	import TaskTree from '$lib/tasks/TaskTree.svelte';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';

	const taskId = $derived(page.params.id ?? '');

	type TaskDetail = NonNullable<Awaited<ReturnType<typeof getTaskByIdQuery>>>;
	type Status = TaskDetail['task']['status'];
	type Subtree = NonNullable<Awaited<ReturnType<typeof getTaskSubtreeQuery>>>;

	type RepoSummary = Awaited<ReturnType<typeof listConnectedRepositoriesQuery>>[number];

	let detail = $state<TaskDetail | null>(null);
	let subtree = $state<Subtree | null>(null);
	let loading = $state(true);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let repos = $state<RepoSummary[] | null>(null);
	let repoPickerOpen = $state(false);
	let repoBusy = $state(false);
	let repoError = $state<string | null>(null);
	const linkedRepo = $derived(detail?.task.repositoryId
		? repos?.find((r) => r.id === detail!.task.repositoryId) ?? null
		: null);

	onMount(() => {
		void load();
	});

	async function load(forceRefresh = false) {
		loading = true;
		error = null;
		try {
			// SvelteKit remote queries cache by default; calling `.refresh()` invalidates the
			// cache so the next read returns fresh data. The first load (initial onMount)
			// doesn't need it — there's nothing to invalidate yet.
			if (forceRefresh) {
				await Promise.all([
					getTaskByIdQuery(taskId).refresh().catch(() => undefined),
					getTaskSubtreeQuery({ rootTaskId: taskId, maxDepth: 4 }).refresh().catch(() => undefined),
				]);
			}
			const [d, s] = await Promise.all([
				getTaskByIdQuery(taskId),
				getTaskSubtreeQuery({ rootTaskId: taskId, maxDepth: 4 }).catch(() => null),
			]);
			detail = d;
			subtree = s;
			if (!d) error = 'Task not found';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load';
		} finally {
			loading = false;
		}
	}

	const TERMINAL: Status[] = ['completed', 'failed', 'canceled'];

	function statusTone(s: Status): string {
		switch (s) {
			case 'pending':
				return 'badge-ghost';
			case 'planning':
				return 'badge-info';
			case 'awaiting_approval':
				return 'badge-warning';
			case 'running':
				return 'badge-primary';
			case 'blocked':
			case 'failed':
				return 'badge-error';
			case 'completed':
				return 'badge-success';
			case 'canceled':
				return 'badge-ghost';
			default:
				return 'badge-ghost';
		}
	}

	async function transition(next: Status) {
		if (!detail) return;
		busy = true;
		try {
			await setTaskStatusCommand({ taskId: detail.task.id, status: next });
			await load(true);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to update status';
		} finally {
			busy = false;
		}
	}

	async function handleCancel() {
		if (!detail) return;
		if (!confirm('Cancel this task and any pending children?')) return;
		busy = true;
		try {
			await cancelTaskCommand({ taskId: detail.task.id });
			await load(true);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Cancel failed';
		} finally {
			busy = false;
		}
	}

	async function loadRepos() {
		if (repos !== null) return;
		try {
			repos = await listConnectedRepositoriesQuery();
		} catch (e) {
			repoError = e instanceof Error ? e.message : 'Failed to load repos';
		}
	}

	async function openRepoPicker() {
		repoError = null;
		repoPickerOpen = true;
		await loadRepos();
	}

	async function attachRepo(repoId: string | null) {
		if (!detail) return;
		repoBusy = true;
		repoError = null;
		try {
			await setTaskRepositoryCommand({ taskId: detail.task.id, repositoryId: repoId });
			// Reload first so the badge reflects the new state, then close the picker. Closing
			// before refresh produced a one-roundtrip flicker where the badge showed the old
			// link, and a fast double-click could fire the command twice against stale state.
			await load(true);
			repoPickerOpen = false;
		} catch (e) {
			repoError = e instanceof Error ? e.message : 'Failed to update repository';
		} finally {
			repoBusy = false;
		}
	}

	async function handleRetry() {
		if (!detail) return;
		if (!detail.task.ownerAgentId) {
			error = 'Task has no owner agent — assign one before retrying.';
			return;
		}
		if (!confirm('Retry this task? A new attempt + run will be created.')) return;
		busy = true;
		error = null;
		try {
			await retryTaskCommand({ taskId: detail.task.id });
			await load(true);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Retry failed';
		} finally {
			busy = false;
		}
	}

	function fmtCost(usd: string | null | undefined) {
		if (usd === null || usd === undefined) return '—';
		const n = parseFloat(usd);
		return Number.isNaN(n) ? '—' : n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`;
	}

	function fmtDate(iso: Date | string | null | undefined) {
		if (!iso) return '—';
		return new Date(iso).toLocaleString();
	}
</script>

{#if loading}
	<div class="flex justify-center py-20">
		<span class="loading loading-spinner loading-lg text-primary"></span>
	</div>
{:else if error || !detail}
	<div class="py-20 text-center">
		<p class="text-sm text-base-content/55">{error ?? 'Task not found.'}</p>
		<a class="btn btn-ghost btn-sm mt-4" href="/tasks">← Back to tasks</a>
	</div>
{:else}
	{@const t = detail.task}
	{@const isTerminal = TERMINAL.includes(t.status)}
	<section class="space-y-4">
		<a class="btn btn-sm btn-ghost -ml-1 w-fit" href="/tasks">← All tasks</a>

		<ContentPanel>
			{#snippet header()}
				<div class="flex flex-1 flex-wrap items-start justify-between gap-2">
					<div class="min-w-0 flex-1">
						<div class="flex flex-wrap items-center gap-2">
							<h1 class="text-xl font-bold leading-tight sm:text-2xl">{t.title}</h1>
							<span class="badge badge-sm {statusTone(t.status)}">{t.status}</span>
						</div>
						<p class="mt-1 text-xs text-base-content/55">
							Created {fmtDate(t.createdAt)} · Updated {fmtDate(t.updatedAt)}
						</p>
					</div>
					<div class="flex flex-wrap items-center gap-2">
						{#if (t.status === 'failed' || t.status === 'blocked' || t.status === 'completed') && t.ownerAgentId}
							<button class="btn btn-info btn-xs" type="button" onclick={handleRetry} disabled={busy} title="Run this task again with a new attempt">
								{busy ? 'Retrying…' : 'Retry'}
							</button>
						{/if}
						{#if t.status === 'pending' || t.status === 'planning' || t.status === 'awaiting_approval'}
							<button class="btn btn-primary btn-xs" type="button" onclick={() => transition('running')} disabled={busy}>Mark running</button>
						{/if}
						{#if t.status === 'running'}
							<button class="btn btn-success btn-xs" type="button" onclick={() => transition('completed')} disabled={busy}>Mark completed</button>
							<button class="btn btn-error btn-xs btn-outline" type="button" onclick={() => transition('failed')} disabled={busy}>Mark failed</button>
							<button class="btn btn-warning btn-xs btn-outline" type="button" onclick={() => transition('blocked')} disabled={busy}>Mark blocked</button>
						{/if}
						{#if !isTerminal}
							<button class="btn btn-ghost btn-xs" type="button" onclick={handleCancel} disabled={busy}>Cancel</button>
						{/if}
					</div>
				</div>
			{/snippet}

			<div class="space-y-3">
				{#if t.budgetUsd || t.priority > 0}
					<div class="flex flex-wrap gap-2 text-xs">
						{#if t.budgetUsd}
							<span class="badge badge-sm badge-outline font-mono">budget: {fmtCost(t.budgetUsd)}</span>
						{/if}
						{#if t.priority > 0}
							<span class="badge badge-sm badge-outline">priority {t.priority}</span>
						{/if}
					</div>
				{/if}

				<!-- Wave 5 #19 phase 2 finish — repo linkage. The runner reads tasks.repositoryId
				     to decide whether to provision a real worktree before invoking runChatLoop. -->
				<div class="flex flex-wrap items-center gap-2 text-xs">
					<span class="text-base-content/55 font-medium">Repository:</span>
					{#if linkedRepo}
						<span class="badge badge-sm badge-info gap-1.5 font-mono">
							{linkedRepo.owner}/{linkedRepo.name}
						</span>
						{#if linkedRepo.htmlUrl}
							<a class="text-base-content/55 hover:text-info" href={linkedRepo.htmlUrl} target="_blank" rel="noopener">↗</a>
						{/if}
						<button class="btn btn-ghost btn-xs" type="button" onclick={() => attachRepo(null)} disabled={repoBusy || isTerminal}>Detach</button>
					{:else if t.repositoryId}
						<span class="badge badge-sm badge-error font-mono" title="Linked repo not found in your synced list — re-sync /source-control or detach.">
							missing repo
						</span>
						<button class="btn btn-ghost btn-xs" type="button" onclick={() => attachRepo(null)} disabled={repoBusy || isTerminal}>Detach</button>
					{:else}
						<span class="text-base-content/55">none — runs use the agent's default workspace</span>
						{#if !isTerminal}
							<button class="btn btn-ghost btn-xs" type="button" onclick={openRepoPicker} disabled={repoBusy}>Attach</button>
						{/if}
					{/if}
				</div>

				{#if repoPickerOpen}
					<div class="rounded-lg border border-base-300 bg-base-100/50 p-3 space-y-2">
						<div class="flex items-center justify-between gap-2">
							<p class="text-xs font-semibold text-base-content/70">Select a repository to attach</p>
							<button class="btn btn-ghost btn-xs" type="button" onclick={() => (repoPickerOpen = false)}>Close</button>
						</div>
						{#if repos === null}
							<p class="text-xs text-base-content/55">Loading…</p>
						{:else if repos.length === 0}
							<p class="text-xs text-base-content/55">
								No repos synced yet. <a class="link" href="/source-control">Connect GitHub</a> first.
							</p>
						{:else}
							<div class="flex flex-wrap gap-1.5">
								{#each repos as r (r.id)}
									<button
										class="btn btn-ghost btn-xs font-mono"
										type="button"
										onclick={() => attachRepo(r.id)}
										disabled={repoBusy}
									>
										{r.owner}/{r.name}{r.private ? ' 🔒' : ''}
									</button>
								{/each}
							</div>
						{/if}
						{#if repoError}
							<p class="text-xs text-error">{repoError}</p>
						{/if}
					</div>
				{/if}
				<div>
					<p class="mb-1 text-xs font-semibold uppercase tracking-wide text-base-content/45">Spec</p>
					<pre class="max-h-96 overflow-auto whitespace-pre-wrap rounded-xl bg-base-200 p-3 text-xs leading-relaxed">{t.spec}</pre>
				</div>
				{#if t.metadata && Object.keys(t.metadata).length > 0}
					<details class="rounded-xl border border-base-300/60 bg-base-200/30 p-3">
						<summary class="cursor-pointer text-xs font-semibold uppercase tracking-wide text-base-content/45">Metadata</summary>
						<pre class="mt-2 overflow-auto text-xs">{JSON.stringify(t.metadata, null, 2)}</pre>
					</details>
				{/if}
			</div>
		</ContentPanel>

		{#if detail.children.length > 0}
			{@const subtreeNodes = subtree?.flat ?? []}
			{@const hasGrandchildren = subtreeNodes.some((n) => n.depth > 1)}
			<ContentPanel>
				{#snippet header()}
					<div class="flex items-center gap-2">
						<h2 class="font-semibold">{hasGrandchildren ? 'Subtree' : 'Steps'}</h2>
						<span class="badge badge-sm badge-ghost">
							{hasGrandchildren ? subtreeNodes.length - 1 : (detail?.children.length ?? 0)}
						</span>
					</div>
				{/snippet}
				{#if hasGrandchildren && subtreeNodes.length > 1}
					<TaskTree nodes={subtreeNodes.slice(1)} highlightTaskId={detail.task.id} />
				{:else}
					<ol class="space-y-2 text-sm">
						{#each detail.children as child (child.id)}
							<li>
								<a href="/tasks/{child.id}" class="flex items-center gap-2 rounded-xl border border-base-300/60 bg-base-100 px-3 py-2 transition-colors hover:border-base-content/30">
									<span class="font-mono text-xs text-base-content/55 tabular-nums">{child.priority + 1}.</span>
									<span class="line-clamp-1 flex-1 font-medium">{child.title}</span>
									<span class="badge badge-xs {statusTone(child.status as Status)}">{child.status}</span>
								</a>
							</li>
						{/each}
					</ol>
				{/if}
			</ContentPanel>
		{/if}

		<ContentPanel>
			{#snippet header()}
				<div class="flex items-center gap-2">
					<h2 class="font-semibold">Attempts</h2>
					<span class="badge badge-sm badge-ghost">{detail?.attempts.length ?? 0}</span>
				</div>
			{/snippet}
			{#if detail.attempts.length === 0}
				<p class="py-4 text-center text-sm italic text-base-content/45">No attempts recorded yet.</p>
			{:else}
				<ul class="space-y-2 text-sm">
					{#each detail.attempts as attempt (attempt.id)}
						<li class="flex items-center gap-2 rounded-xl border border-base-300/60 bg-base-100 px-3 py-2">
							<span class="font-mono text-xs text-base-content/55 tabular-nums">#{attempt.attemptNumber}</span>
							<span class="badge badge-xs {statusTone(attempt.status as Status)}">{attempt.status}</span>
							<span class="text-xs text-base-content/55">started {fmtDate(attempt.startedAt)}</span>
							<span class="ml-auto font-mono text-xs tabular-nums">{fmtCost(attempt.costUsd)}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</ContentPanel>

		{#if detail.linkedRuns.length > 0}
			<ContentPanel>
				{#snippet header()}
					<div class="flex items-center gap-2">
						<h2 class="font-semibold">Linked runs</h2>
						<span class="badge badge-sm badge-ghost">{detail?.linkedRuns.length ?? 0}</span>
					</div>
				{/snippet}
				<ul class="space-y-2 text-sm">
					{#each detail.linkedRuns as run (run.id)}
						<li class="flex items-center gap-2 rounded-xl border border-base-300/60 bg-base-100 px-3 py-2 transition-colors hover:border-base-content/30">
							<span class="badge badge-xs badge-ghost">{run.state}</span>
							<span class="line-clamp-1 flex-1 font-medium">{run.label ?? '(unnamed run)'}</span>
							<span class="font-mono text-xs text-base-content/55">{fmtDate(run.startedAt)}</span>
							<a href="/runs/{run.id}" class="btn btn-ghost btn-xs" title="Open the run trace">Trace</a>
							<a href="/chat/{run.conversationId}" class="btn btn-ghost btn-xs" title="Open the conversation">Chat</a>
						</li>
					{/each}
				</ul>
			</ContentPanel>
		{/if}
	</section>
{/if}
