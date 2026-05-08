<script lang="ts">
	import {
		commitProjectCommand,
		createProjectBranchCommand,
		getProjectDiffQuery,
		getProjectRepoDetailQuery,
		pullProjectCommand,
		pushProjectBranchCommand,
		switchProjectBranchCommand,
	} from '$lib/projects/projects.remote';

	type RepoDetail = Awaited<ReturnType<typeof getProjectRepoDetailQuery>>;
	type DiffResult = Awaited<ReturnType<typeof getProjectDiffQuery>>;

	let { projectId, repoKind }: { projectId: string; repoKind: 'none' | 'local' | 'imported' } = $props();

	let detail = $state<RepoDetail | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let busy = $state(false);
	let actionMessage = $state<string | null>(null);

	let commitMessage = $state('');
	let newBranchName = $state('');
	let newBranchFrom = $state('');
	let pushBranch = $state('');
	let pushForce = $state(false);

	let diff = $state<DiffResult | null>(null);
	let diffOpen = $state(false);
	let diffRef = $state('HEAD');
	let diffLoading = $state(false);

	async function load() {
		loading = true;
		error = null;
		try {
			detail = await getProjectRepoDetailQuery({ projectId });
			if (detail.status?.branch) pushBranch = detail.status.branch;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load repo detail';
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		if (projectId) void load();
	});

	async function runAction<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
		busy = true;
		actionMessage = null;
		try {
			const result = await fn();
			actionMessage = `${label} ✓`;
			return result;
		} catch (e) {
			actionMessage = e instanceof Error ? e.message : `${label} failed`;
			return null;
		} finally {
			busy = false;
		}
	}

	async function pull() {
		await runAction('Pull latest', () => pullProjectCommand({ projectId }));
		await load();
	}

	async function commit(event: Event) {
		event.preventDefault();
		const msg = commitMessage.trim();
		if (!msg) { actionMessage = 'Commit message required'; return; }
		const result = await runAction('Commit', () => commitProjectCommand({ projectId, message: msg }));
		if (result?.committed) {
			commitMessage = '';
			actionMessage = `Committed ${result.sha?.slice(0, 7) ?? ''}`;
		} else if (result && !result.committed) {
			actionMessage = 'Nothing to commit — working tree clean';
		}
		await load();
	}

	async function createBranch(event: Event) {
		event.preventDefault();
		const name = newBranchName.trim();
		if (!name) { actionMessage = 'Branch name required'; return; }
		await runAction(`Create branch ${name}`, () =>
			createProjectBranchCommand({ projectId, name, from: newBranchFrom.trim() || undefined }),
		);
		newBranchName = '';
		newBranchFrom = '';
		await load();
	}

	async function switchBranch(branch: string) {
		await runAction(`Switch to ${branch}`, () => switchProjectBranchCommand({ projectId, name: branch }));
		await load();
	}

	async function push() {
		const branch = pushBranch.trim();
		if (!branch) { actionMessage = 'No branch to push'; return; }
		const result = await runAction(`Push ${branch}${pushForce ? ' (force-with-lease)' : ''}`, () =>
			pushProjectBranchCommand({ projectId, branch, force: pushForce }),
		);
		if (result && !result.success) {
			actionMessage = `Push failed (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 400)}`;
		}
		await load();
	}

	async function loadDiff() {
		diffLoading = true;
		try {
			diff = await getProjectDiffQuery({ projectId, ref: diffRef.trim() || 'HEAD' });
			diffOpen = true;
		} catch (e) {
			actionMessage = e instanceof Error ? e.message : 'Diff failed';
		} finally {
			diffLoading = false;
		}
	}

	function fmtRelative(d: Date | string | null | undefined): string {
		if (!d) return '—';
		const ms = Date.now() - new Date(d).getTime();
		const sec = Math.round(ms / 1000);
		if (sec < 60) return `${sec}s ago`;
		const min = Math.round(sec / 60);
		if (min < 60) return `${min}m ago`;
		const hr = Math.round(min / 60);
		if (hr < 24) return `${hr}h ago`;
		const day = Math.round(hr / 24);
		if (day < 30) return `${day}d ago`;
		return new Date(d).toLocaleDateString();
	}
</script>

{#if repoKind === 'none'}
	<div class="rounded-xl border border-base-300/60 bg-base-200/30 p-8 text-center text-sm text-base-content/55">
		This project has no filesystem footprint. Create a new project with a local or imported repo to get git controls.
	</div>
{:else if loading}
	<div class="flex justify-center py-10">
		<span class="loading loading-spinner loading-md text-primary"></span>
	</div>
{:else if error || !detail}
	<div class="alert alert-error text-sm">{error ?? 'Failed to load.'}</div>
{:else}
	<div class="space-y-3">
		{#if actionMessage}
			<div class="alert alert-info py-2 text-xs">{actionMessage}</div>
		{/if}

		<!-- ── Status + path ─────────────────────────────────────────── -->
		<div class="rounded-xl border border-base-300/60 bg-base-100 p-3 text-sm">
			<div class="mb-2 flex flex-wrap items-center gap-2">
				<span class="font-semibold">Working tree</span>
				{#if detail.status}
					{#if detail.status.dirty}
						<span class="badge badge-warning badge-sm">{detail.status.files.length} change{detail.status.files.length === 1 ? '' : 's'}</span>
					{:else}
						<span class="badge badge-success badge-sm">clean</span>
					{/if}
					<span class="badge badge-ghost badge-sm">on <code>{detail.status.branch ?? '(detached)'}</code></span>
					{#if detail.status.upstream}
						<span class="text-xs opacity-60">↔ {detail.status.upstream}</span>
					{/if}
					{#if detail.status.ahead > 0}
						<span class="text-xs opacity-70">↑{detail.status.ahead}</span>
					{/if}
					{#if detail.status.behind > 0}
						<span class="text-xs opacity-70">↓{detail.status.behind}</span>
					{/if}
				{:else}
					<span class="badge badge-error badge-sm">no git</span>
				{/if}
			</div>
			{#if detail.project.repoLocalPath}
				<p class="font-mono text-[10px] opacity-50">{detail.project.repoLocalPath}</p>
			{/if}
			{#if detail.repository}
				<p class="mt-1 text-xs opacity-60">
					Imported from <code>{detail.repository.owner}/{detail.repository.name}</code>
					· last pulled {fmtRelative(detail.project.lastPulledAt)}
				</p>
			{/if}

			{#if detail.status && detail.status.dirty}
				<details class="mt-2">
					<summary class="cursor-pointer text-xs opacity-70">{detail.status.files.length} changed file{detail.status.files.length === 1 ? '' : 's'}</summary>
					<ul class="mt-1 max-h-48 space-y-0.5 overflow-y-auto font-mono text-[11px]">
						{#each detail.status.files as f}
							<li class="opacity-80">
								<code class="opacity-50">{f.indexStatus}{f.worktreeStatus}</code> {f.path}
								{#if f.renamedFrom}
									<span class="opacity-50">(from {f.renamedFrom})</span>
								{/if}
							</li>
						{/each}
					</ul>
				</details>
			{/if}
		</div>

		<!-- ── Action bar: pull / push / diff ────────────────────────── -->
		<div class="flex flex-wrap gap-2">
			{#if repoKind === 'imported'}
				<button class="btn btn-sm btn-outline" type="button" onclick={pull} disabled={busy}>
					Pull latest
				</button>
			{/if}
			<button class="btn btn-sm btn-outline" type="button" onclick={loadDiff} disabled={busy || diffLoading}>
				{diffLoading ? 'Loading…' : `View diff vs ${diffRef}`}
			</button>
			<input
				type="text"
				class="input input-xs input-bordered w-32"
				bind:value={diffRef}
				placeholder="HEAD"
				disabled={busy}
			/>
		</div>

		<!-- ── Commit form ───────────────────────────────────────────── -->
		<form class="rounded-xl border border-base-300/60 bg-base-100 p-3" onsubmit={commit}>
			<label class="text-xs font-semibold opacity-70" for="commit-msg">Commit working tree</label>
			<div class="mt-1 flex flex-wrap gap-2">
				<input
					id="commit-msg"
					type="text"
					class="input input-sm input-bordered flex-1"
					bind:value={commitMessage}
					placeholder="commit message"
					maxlength="2000"
				/>
				<button type="submit" class="btn btn-sm btn-primary" disabled={busy || !commitMessage.trim()}>
					Stage all + commit
				</button>
			</div>
		</form>

		<!-- ── Branches + push ───────────────────────────────────────── -->
		<div class="grid gap-3 lg:grid-cols-2">
			<div class="rounded-xl border border-base-300/60 bg-base-100 p-3">
				<h3 class="mb-2 text-sm font-semibold">Branches</h3>
				<form class="mb-2 flex flex-wrap gap-2" onsubmit={createBranch}>
					<input
						type="text"
						class="input input-xs input-bordered flex-1"
						bind:value={newBranchName}
						placeholder="new branch name"
						maxlength="200"
					/>
					<input
						type="text"
						class="input input-xs input-bordered w-28"
						bind:value={newBranchFrom}
						placeholder="from (opt.)"
						maxlength="200"
					/>
					<button type="submit" class="btn btn-xs btn-outline" disabled={busy || !newBranchName.trim()}>
						Create
					</button>
				</form>
				<ul class="max-h-64 space-y-1 overflow-y-auto text-xs">
					{#each detail.branches as b (b.name)}
						<li class="flex items-center justify-between gap-2 rounded border border-base-300/40 bg-base-200/30 p-1.5">
							<span class="flex-1">
								<code>{b.name}</code>
								{#if b.isCurrent}
									<span class="badge badge-xs badge-success ml-1">current</span>
								{/if}
								{#if b.isRemote}
									<span class="badge badge-xs badge-ghost ml-1">remote</span>
								{/if}
							</span>
							{#if !b.isCurrent && !b.isRemote}
								<button
									type="button"
									class="btn btn-xs btn-ghost"
									onclick={() => switchBranch(b.name)}
									disabled={busy}
								>
									Switch
								</button>
							{/if}
						</li>
					{/each}
				</ul>
			</div>

			{#if repoKind === 'imported' && detail.repository?.provider === 'github'}
				<div class="rounded-xl border border-base-300/60 bg-base-100 p-3">
					<h3 class="mb-2 text-sm font-semibold">Push to GitHub</h3>
					<div class="space-y-2">
						<input
							type="text"
							class="input input-sm input-bordered w-full"
							bind:value={pushBranch}
							placeholder="branch to push"
						/>
						<label class="flex items-center gap-2 text-xs">
							<input type="checkbox" class="checkbox checkbox-xs" bind:checked={pushForce} />
							<span>--force-with-lease (only if remote ref hasn't moved)</span>
						</label>
						<button class="btn btn-sm btn-primary w-full" type="button" onclick={push} disabled={busy || !pushBranch.trim()}>
							Push {pushBranch}
						</button>
					</div>
				</div>
			{:else if repoKind === 'imported'}
				<div class="rounded-xl border border-base-300/60 bg-base-200/30 p-3 text-xs opacity-70">
					Push is only wired up for GitHub-backed projects right now.
					Azure / generic remotes can be pushed via the agent's git tools.
				</div>
			{/if}
		</div>

		<!-- ── Recent commits ────────────────────────────────────────── -->
		<div class="rounded-xl border border-base-300/60 bg-base-100 p-3">
			<h3 class="mb-2 text-sm font-semibold">Recent commits ({detail.commits.length})</h3>
			{#if detail.commits.length === 0}
				<p class="text-xs italic opacity-55">No commits yet.</p>
			{:else}
				<ul class="space-y-1 text-xs">
					{#each detail.commits as commit (commit.sha)}
						<li class="rounded border border-base-300/40 bg-base-200/20 p-1.5">
							<div class="flex flex-wrap items-center gap-2">
								<code class="text-[10px] opacity-60">{commit.sha.slice(0, 7)}</code>
								<span class="font-medium">{commit.subject}</span>
							</div>
							<div class="text-[10px] opacity-55">
								{commit.authorName} · {fmtRelative(commit.isoDate)}
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</div>

		<!-- ── Pull requests + linked chats ──────────────────────────── -->
		<div class="grid gap-3 lg:grid-cols-2">
			{#if detail.repository}
				<div class="rounded-xl border border-base-300/60 bg-base-100 p-3">
					<h3 class="mb-2 text-sm font-semibold">Pull requests ({detail.pullRequests.length})</h3>
					{#if detail.pullRequests.length === 0}
						<p class="text-xs italic opacity-55">No pull requests recorded.</p>
					{:else}
						<ul class="space-y-1 text-xs">
							{#each detail.pullRequests as pr (pr.id)}
								<li class="rounded border border-base-300/40 bg-base-200/20 p-1.5">
									<div class="flex flex-wrap items-center gap-2">
										<span class="badge badge-xs badge-ghost">{pr.status}</span>
										<span class="font-medium">#{pr.providerPrNumber} {pr.title}</span>
									</div>
									<div class="text-[10px] opacity-55">
										{pr.headBranch} → {pr.baseBranch} · {fmtRelative(pr.updatedAt)}
									</div>
									{#if pr.providerUrl}
										<a class="link link-hover text-[10px]" href={pr.providerUrl} target="_blank" rel="noopener">
											Open ↗
										</a>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			{/if}
			<div class="rounded-xl border border-base-300/60 bg-base-100 p-3">
				<h3 class="mb-2 text-sm font-semibold">Linked chats ({detail.conversations.length})</h3>
				{#if detail.conversations.length === 0}
					<p class="text-xs italic opacity-55">
						No chats bound to this project yet. Start a chat and bind it to keep work in scope.
					</p>
				{:else}
					<ul class="space-y-1 text-xs">
						{#each detail.conversations as chat (chat.id)}
							<li class="rounded border border-base-300/40 bg-base-200/20 p-1.5">
								<a href={`/chat/${chat.id}`} class="link link-hover font-medium">{chat.title}</a>
								<div class="text-[10px] opacity-55">
									{chat.agentName ?? 'Chat'} · {fmtRelative(chat.updatedAt)}
								</div>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</div>
	</div>

	<!-- ── Diff viewer modal ─────────────────────────────────────── -->
	{#if diffOpen && diff}
		<div class="modal modal-open">
			<div class="modal-box max-w-5xl">
				<div class="mb-3 flex items-center justify-between">
					<h2 class="text-lg font-bold">Diff vs <code>{diff.ref}</code></h2>
					<button class="btn btn-sm btn-ghost" type="button" onclick={() => (diffOpen = false)}>✕</button>
				</div>
				{#if diff.files.length === 0}
					<p class="text-sm italic opacity-60">No differences.</p>
				{:else}
					<div class="space-y-3 max-h-[70vh] overflow-y-auto">
						{#each diff.files as file (file.path)}
							<details open class="rounded border border-base-300/60 bg-base-200/30">
								<summary class="cursor-pointer p-2 font-mono text-xs font-semibold">{file.path}</summary>
								<pre class="overflow-x-auto bg-base-300/30 p-2 font-mono text-[11px] leading-tight"><code>{file.hunks}</code></pre>
							</details>
						{/each}
					</div>
				{/if}
			</div>
			<button class="modal-backdrop" type="button" onclick={() => (diffOpen = false)} aria-label="Close"></button>
		</div>
	{/if}
{/if}
