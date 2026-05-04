<svelte:head><title>Source control | AgentStudio</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import {
		disconnectGithubCommand,
		getSourceControlOverviewQuery,
		syncGithubReposCommand,
	} from '$lib/source-control/source-control.remote';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';

	type Overview = Awaited<ReturnType<typeof getSourceControlOverviewQuery>>;

	let overview = $state<Overview | null>(null);
	let loading = $state(true);
	let syncing = $state(false);
	let busy = $state(false);
	let errorMessage = $state<string | null>(null);
	let lastSyncSummary = $state<string | null>(null);

	const errorParam = $derived(page.url.searchParams.get('error'));
	const githubConnection = $derived(overview?.connections.find((c) => c.provider === 'github' && c.status === 'active') ?? null);
	const revokedConnection = $derived(overview?.connections.find((c) => c.provider === 'github' && c.status !== 'active') ?? null);
	const githubRepos = $derived(overview?.repositories.filter((r) => r.provider === 'github') ?? []);

	async function load() {
		loading = true;
		errorMessage = null;
		try {
			overview = await getSourceControlOverviewQuery();
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Failed to load overview';
		} finally {
			loading = false;
		}
	}

	async function syncRepos() {
		if (!githubConnection) return;
		syncing = true;
		errorMessage = null;
		lastSyncSummary = null;
		try {
			const result = await syncGithubReposCommand({});
			if (result.errorMessage) {
				errorMessage = result.errorMessage;
			} else {
				lastSyncSummary = `Synced ${result.total} repos · ${result.inserted} new · ${result.updated} updated · ${result.skipped} skipped (forks/archived)`;
			}
			await load();
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Sync failed';
		} finally {
			syncing = false;
		}
	}

	async function disconnect() {
		if (!confirm('Disconnect GitHub? Your stored token will be revoked. Repos already synced will stay until you delete them.')) return;
		busy = true;
		try {
			await disconnectGithubCommand();
			await load();
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Disconnect failed';
		} finally {
			busy = false;
		}
	}

	function fmtDate(d: Date | string | null): string {
		if (!d) return '—';
		return new Date(d).toLocaleString();
	}

	onMount(load);
</script>

<div class="flex h-full min-h-0 flex-col space-y-3 sm:space-y-4">
	<ContentPanel>
		{#snippet header()}
			<div class="flex flex-1 flex-wrap items-center justify-between gap-2">
				<div>
					<h1 class="text-xl font-bold sm:text-3xl">Source control</h1>
					<p class="text-xs text-base-content/70 sm:text-sm">
						Connect a provider once. Repos sync into AgentStudio so coding agents and tasks can target them.
					</p>
				</div>
			</div>
		{/snippet}

		{#if errorParam}
			<div class="alert alert-error mb-3 text-sm">
				<span>OAuth error: <code>{errorParam}</code>. Try connecting again.</span>
			</div>
		{/if}

		{#if loading}
			<p class="opacity-70">Loading…</p>
		{:else if !overview}
			<p class="text-error">Failed to load overview.</p>
		{:else}
			<!-- ── GitHub connection card ────────────────────────────────────────── -->
			<div class="rounded-lg border border-base-300 bg-base-100 p-4">
				<div class="flex flex-wrap items-center justify-between gap-3">
					<div class="flex items-center gap-3">
						<div class="text-3xl">⚡</div>
						<div>
							<div class="font-semibold">GitHub</div>
							{#if githubConnection}
								<div class="text-sm opacity-70">
									Connected as <code>{githubConnection.providerAccount}</code>
									<span class="badge badge-success badge-xs ml-2">active</span>
								</div>
								<div class="mt-1 text-xs opacity-50">
									Scopes: {githubConnection.scopes.join(', ') || 'none'} · Last sync: {fmtDate(githubConnection.lastSyncedAt)}
								</div>
							{:else if revokedConnection}
								<div class="text-sm opacity-70">
									Previously connected as <code>{revokedConnection.providerAccount}</code>
									<span class="badge badge-error badge-xs ml-2">{revokedConnection.status}</span>
								</div>
								{#if revokedConnection.lastError}
									<div class="mt-1 text-xs text-error">{revokedConnection.lastError}</div>
								{/if}
							{:else}
								<div class="text-sm opacity-70">Not connected.</div>
							{/if}
						</div>
					</div>
					<div class="flex gap-2">
						{#if !overview.githubConfigured}
							<span class="badge badge-warning badge-sm" title="Set GITHUB_OAUTH_CLIENT_ID + GITHUB_OAUTH_CLIENT_SECRET in env">
								Not configured
							</span>
						{:else if githubConnection}
							<button class="btn btn-primary btn-sm" type="button" onclick={syncRepos} disabled={syncing}>
								{syncing ? 'Syncing…' : 'Sync repos'}
							</button>
							<a class="btn btn-outline btn-sm" href="/source-control/github/connect">Reconnect</a>
							<button class="btn btn-error btn-outline btn-sm" type="button" onclick={disconnect} disabled={busy}>
								Disconnect
							</button>
						{:else}
							<a class="btn btn-primary btn-sm" href="/source-control/github/connect">Connect GitHub</a>
						{/if}
					</div>
				</div>
				{#if !overview.githubConfigured}
					<div class="mt-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs">
						<p class="font-semibold">GitHub OAuth not configured.</p>
						<p class="mt-1 opacity-80">
							Register a GitHub OAuth App at <a class="link" href="https://github.com/settings/developers" target="_blank" rel="noopener">github.com/settings/developers</a> with the callback URL set to <code>{`${page.url.origin}/source-control/github/callback`}</code>, then set:
						</p>
						<ul class="mt-2 list-disc pl-5 leading-relaxed">
							<li><code>GITHUB_OAUTH_CLIENT_ID</code></li>
							<li><code>GITHUB_OAUTH_CLIENT_SECRET</code></li>
							<li><code>APP_ENCRYPTION_KEY</code> (any long random string — used to encrypt stored tokens)</li>
						</ul>
					</div>
				{/if}
				{#if lastSyncSummary}
					<div class="alert alert-success mt-3 py-2 text-sm">{lastSyncSummary}</div>
				{/if}
				{#if errorMessage}
					<div class="alert alert-error mt-3 py-2 text-sm">{errorMessage}</div>
				{/if}
			</div>

			<!-- ── Repository list ───────────────────────────────────────────────── -->
			<div class="mt-4">
				<h2 class="mb-2 text-lg font-semibold">Synced repositories ({githubRepos.length})</h2>
				{#if githubRepos.length === 0}
					<p class="rounded-lg border border-base-300 bg-base-200 p-4 text-sm opacity-70">
						{githubConnection ? 'Click "Sync repos" to pull your GitHub repos.' : 'Connect GitHub to start syncing repos.'}
					</p>
				{:else}
					<div class="overflow-x-auto rounded-lg border border-base-300 bg-base-100">
						<table class="table table-sm table-zebra">
							<thead>
								<tr>
									<th>Owner / Name</th>
									<th>Default</th>
									<th>Visibility</th>
									<th>Updated</th>
									<th>Actions</th>
								</tr>
							</thead>
							<tbody>
								{#each githubRepos as repo (repo.id)}
									{@const meta = repo.metadata as { htmlUrl?: string; private?: boolean; description?: string | null; archived?: boolean; fork?: boolean }}
									<tr>
										<td>
											<div class="flex flex-col">
												<span class="font-mono text-sm">{repo.owner}/{repo.name}</span>
												{#if meta?.description}
													<span class="text-xs opacity-60">{meta.description}</span>
												{/if}
											</div>
										</td>
										<td><code class="text-xs">{repo.defaultBranch}</code></td>
										<td>
											<span class="badge badge-sm {meta?.private ? 'badge-warning' : 'badge-ghost'}">
												{meta?.private ? 'private' : 'public'}
											</span>
											{#if meta?.archived}
												<span class="badge badge-sm badge-error ml-1">archived</span>
											{/if}
										</td>
										<td class="text-xs opacity-70">{fmtDate(repo.updatedAt)}</td>
										<td>
											{#if meta?.htmlUrl}
												<a class="link link-xs" href={meta.htmlUrl} target="_blank" rel="noopener">Open ↗</a>
											{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</div>
		{/if}
	</ContentPanel>
</div>
