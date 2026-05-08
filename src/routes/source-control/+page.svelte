<svelte:head><title>Source control | AgentStudio</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import {
		detachRepositoryCommand,
		disconnectAzureCommand,
		disconnectGithubCommand,
		getRepositoryDetailQuery,
		getSourceControlOverviewQuery,
		importRepositoryCommand,
		listAzureImportCandidatesQuery,
		listGithubImportCandidatesQuery,
		pullRepositoryCommand,
	} from '$lib/source-control/source-control.remote';
	import { listProjectsQuery } from '$lib/projects/projects.remote';
	import PageHeader from '$lib/ui/PageHeader.svelte';

	type Overview = Awaited<ReturnType<typeof getSourceControlOverviewQuery>>;
	type RepoRow = Overview['repositories'][number];
	type ConnectionRow = Overview['connections'][number];
	type ProjectRow = Awaited<ReturnType<typeof listProjectsQuery>>[number];
	type RepoDetail = Awaited<ReturnType<typeof getRepositoryDetailQuery>>;
	type GithubCandidate = Awaited<ReturnType<typeof listGithubImportCandidatesQuery>>['candidates'][number];
	type AzureCandidate = Awaited<ReturnType<typeof listAzureImportCandidatesQuery>>['candidates'][number];

	let overview = $state<Overview | null>(null);
	let projects = $state<ProjectRow[]>([]);
	let loading = $state(true);
	let busy = $state(false);
	let errorMessage = $state<string | null>(null);

	const errorParam = $derived(page.url.searchParams.get('error'));
	const githubConnection = $derived(
		overview?.connections.find((c) => c.provider === 'github' && c.status === 'active') ?? null,
	);
	const githubRevoked = $derived(
		overview?.connections.find((c) => c.provider === 'github' && c.status !== 'active') ?? null,
	);
	const azureConnections = $derived(
		overview?.connections.filter((c) => c.provider === 'azure_devops' && c.status === 'active') ?? [],
	);
	const azureRevoked = $derived(
		overview?.connections.filter((c) => c.provider === 'azure_devops' && c.status !== 'active') ?? [],
	);
	const repos = $derived(overview?.repositories ?? []);

	// ── Detail expansion state ─────────────────────────────────────────────
	let openRepoId = $state<string | null>(null);
	let detailLoading = $state(false);
	let repoDetail = $state<RepoDetail | null>(null);

	// ── Import modal state ─────────────────────────────────────────────────
	let importOpen = $state(false);
	let importTab = $state<'github' | 'azure' | 'url'>('github');
	let importBusy = $state(false);
	let importError = $state<string | null>(null);
	let importProjectChoice = $state<'auto' | string>('auto');
	let importProjectName = $state('');

	// GitHub picker
	let githubCandidates = $state<GithubCandidate[]>([]);
	let githubError = $state<string | null>(null);
	let githubLoading = $state(false);
	let githubFilter = $state('');

	// Azure picker
	let azureCandidates = $state<AzureCandidate[]>([]);
	let azureError = $state<string | null>(null);
	let azureLoading = $state(false);
	let azureFilter = $state('');

	// URL paste
	let pasteUrl = $state('');
	const pastePreview = $derived(parsePreview(pasteUrl));

	function parsePreview(input: string): string | null {
		const s = input.trim();
		if (!s) return null;
		// Mirror the server-side parser at a coarse level for instant feedback.
		if (/^https?:\/\/[^/@]*github\.com\//i.test(s) || /^git@github\.com:/i.test(s)) {
			const m = s.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
			if (m) return `github · ${m[1]}/${m[2]}`;
		}
		if (/^https?:\/\/[^/@]*dev\.azure\.com\//i.test(s)) {
			const m = s.match(/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+?)(?:\.git)?\/?$/i);
			if (m) return `azure · ${m[1]}/${m[2]}/${m[3]}`;
		}
		if (/\.visualstudio\.com\//i.test(s)) {
			const m = s.match(/([^/.@]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/]+?)(?:\.git)?\/?$/i);
			if (m) return `azure · ${m[1]}/${m[2]}/${m[3]}`;
		}
		try {
			const u = new URL(s);
			const segments = u.pathname.split('/').filter(Boolean);
			const last = segments[segments.length - 1] ?? 'repo';
			return `local · ${u.host}/${last.replace(/\.git$/, '')}`;
		} catch {
			return null;
		}
	}

	onMount(load);

	async function load() {
		loading = true;
		errorMessage = null;
		try {
			[overview, projects] = await Promise.all([getSourceControlOverviewQuery(), listProjectsQuery()]);
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Failed to load overview';
		} finally {
			loading = false;
		}
	}

	async function disconnectGithub() {
		if (!confirm('Disconnect GitHub? Your stored token will be revoked. Imported repos stay until you detach them.')) return;
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

	async function disconnectAzure() {
		if (!confirm('Disconnect all Azure DevOps connections? Imported repos stay until you detach them.')) return;
		busy = true;
		try {
			await disconnectAzureCommand();
			await load();
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Disconnect failed';
		} finally {
			busy = false;
		}
	}

	async function toggleRepoDetail(repoId: string) {
		if (openRepoId === repoId) {
			openRepoId = null;
			repoDetail = null;
			return;
		}
		openRepoId = repoId;
		repoDetail = null;
		detailLoading = true;
		try {
			repoDetail = await getRepositoryDetailQuery({ repositoryId: repoId });
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Failed to load repo detail';
		} finally {
			detailLoading = false;
		}
	}

	async function pullRepo(repoId: string) {
		busy = true;
		errorMessage = null;
		try {
			await pullRepositoryCommand({ repositoryId: repoId });
			if (openRepoId === repoId) {
				repoDetail = await getRepositoryDetailQuery({ repositoryId: repoId });
			}
			await load();
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Pull failed';
		} finally {
			busy = false;
		}
	}

	async function detachRepo(repo: RepoRow) {
		if (!confirm(`Detach ${repo.owner}/${repo.name}? The local clone is preserved on disk.`)) return;
		busy = true;
		errorMessage = null;
		try {
			await detachRepositoryCommand({ repositoryId: repo.id });
			if (openRepoId === repo.id) {
				openRepoId = null;
				repoDetail = null;
			}
			await load();
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Detach failed';
		} finally {
			busy = false;
		}
	}

	function openImportModal(tab: 'github' | 'azure' | 'url' = 'github') {
		importOpen = true;
		importTab = tab;
		importError = null;
		importProjectChoice = 'auto';
		importProjectName = '';
		pasteUrl = '';
		if (tab === 'github' && githubCandidates.length === 0) loadGithubCandidates();
		if (tab === 'azure' && azureCandidates.length === 0) loadAzureCandidates();
	}

	function closeImportModal() {
		importOpen = false;
	}

	async function loadGithubCandidates() {
		githubLoading = true;
		githubError = null;
		try {
			const res = await listGithubImportCandidatesQuery();
			githubCandidates = res.candidates;
			if (res.errorMessage) githubError = res.errorMessage;
		} catch (err) {
			githubError = err instanceof Error ? err.message : 'Failed to list GitHub repos';
		} finally {
			githubLoading = false;
		}
	}

	async function loadAzureCandidates() {
		azureLoading = true;
		azureError = null;
		try {
			const res = await listAzureImportCandidatesQuery();
			azureCandidates = res.candidates;
			if (res.errorMessage) azureError = res.errorMessage;
		} catch (err) {
			azureError = err instanceof Error ? err.message : 'Failed to list Azure DevOps repos';
		} finally {
			azureLoading = false;
		}
	}

	async function importFromCandidate(cloneUrl: string) {
		if (importBusy) return;
		importBusy = true;
		importError = null;
		try {
			await importRepositoryCommand({
				cloneUrl,
				projectId: importProjectChoice === 'auto' ? null : importProjectChoice,
				projectName: importProjectChoice === 'auto' ? importProjectName.trim() || null : null,
			});
			importOpen = false;
			await load();
		} catch (err) {
			importError = err instanceof Error ? err.message : 'Import failed';
		} finally {
			importBusy = false;
		}
	}

	async function importFromUrl(event: Event) {
		event.preventDefault();
		if (importBusy) return;
		const url = pasteUrl.trim();
		if (!url) {
			importError = 'Paste a clone URL.';
			return;
		}
		importBusy = true;
		importError = null;
		try {
			await importRepositoryCommand({
				cloneUrl: url,
				projectId: importProjectChoice === 'auto' ? null : importProjectChoice,
				projectName: importProjectChoice === 'auto' ? importProjectName.trim() || null : null,
			});
			importOpen = false;
			await load();
		} catch (err) {
			importError = err instanceof Error ? err.message : 'Import failed';
		} finally {
			importBusy = false;
		}
	}

	function fmtDate(d: Date | string | null | undefined): string {
		if (!d) return '—';
		return new Date(d).toLocaleString();
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

	function providerBadgeClass(provider: string) {
		if (provider === 'github') return 'badge-neutral';
		if (provider === 'azure_devops') return 'badge-info';
		return 'badge-ghost';
	}

	function providerLabel(provider: string) {
		if (provider === 'github') return 'github';
		if (provider === 'azure_devops') return 'azure';
		return provider;
	}

	function projectHref(projectId: string | null | undefined) {
		return projectId ? `/projects/${projectId}` : null;
	}

	function metaField<T = unknown>(metadata: unknown, key: string): T | null {
		if (!metadata || typeof metadata !== 'object') return null;
		const value = (metadata as Record<string, unknown>)[key];
		return value === undefined ? null : (value as T);
	}

	const filteredGithub = $derived(
		githubFilter.trim()
			? githubCandidates.filter((c) => `${c.owner}/${c.name}`.toLowerCase().includes(githubFilter.toLowerCase()))
			: githubCandidates,
	);
	const filteredAzure = $derived(
		azureFilter.trim()
			? azureCandidates.filter((c) =>
					`${c.org}/${c.project}/${c.name}`.toLowerCase().includes(azureFilter.toLowerCase()),
				)
			: azureCandidates,
	);
</script>

<div class="flex h-full min-h-0 flex-col">
	<PageHeader title="Source control" subtitle="Repos imported into AgentStudio">
		{#snippet actions()}
			<button class="btn btn-xs btn-primary" type="button" onclick={() => openImportModal('github')}>
				+ Import repository
			</button>
		{/snippet}
	</PageHeader>

	<div class="min-h-0 flex-1 overflow-y-auto px-3 py-3 tablet:px-4 desktop:px-4 desktop:py-4 space-y-3 sm:space-y-4">

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
			<!-- ── Connection cards ──────────────────────────────────────────────── -->
			<div class="grid gap-3 sm:grid-cols-2">
				<div class="rounded-lg border border-base-300 bg-base-100 p-4">
					<div class="flex flex-wrap items-center justify-between gap-3">
						<div class="flex items-center gap-3">
							<div class="text-2xl">⚡</div>
							<div>
								<div class="font-semibold">GitHub</div>
								{#if githubConnection}
									<div class="text-sm opacity-70">
										Connected as <code>{githubConnection.providerAccount}</code>
										<span class="badge badge-success badge-xs ml-2">active</span>
									</div>
									<div class="mt-1 text-xs opacity-50">
										Scopes: {githubConnection.scopes.join(', ') || 'none'}
									</div>
								{:else if githubRevoked}
									<div class="text-sm opacity-70">
										Previously connected as <code>{githubRevoked.providerAccount}</code>
										<span class="badge badge-error badge-xs ml-2">{githubRevoked.status}</span>
									</div>
									{#if githubRevoked.lastError}
										<div class="mt-1 text-xs text-error">{githubRevoked.lastError}</div>
									{/if}
								{:else}
									<div class="text-sm opacity-70">Not connected.</div>
								{/if}
							</div>
						</div>
						<div class="flex gap-2">
							{#if !overview.githubConfigured && !githubConnection}
								<span class="badge badge-warning badge-sm" title="Set GITHUB_OAUTH_CLIENT_ID + GITHUB_OAUTH_CLIENT_SECRET in env">
									Not configured
								</span>
							{:else if githubConnection}
								<a class="btn btn-outline btn-xs" href="/source-control/github/connect">Reconnect</a>
								<button class="btn btn-error btn-outline btn-xs" type="button" onclick={disconnectGithub} disabled={busy}>
									Disconnect
								</button>
							{:else}
								<a class="btn btn-primary btn-xs" href="/source-control/github/connect">Connect</a>
							{/if}
						</div>
					</div>
					{#if !overview.githubConfigured}
						<div class="mt-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs">
							<p class="font-semibold">GitHub OAuth not configured.</p>
							<p class="mt-1 opacity-80">
								Register an app at <a class="link" href="https://github.com/settings/developers" target="_blank" rel="noopener">github.com/settings/developers</a>
								with callback <code>{`${page.url.origin}/source-control/github/callback`}</code>, then set
								<code>GITHUB_OAUTH_CLIENT_ID</code>, <code>GITHUB_OAUTH_CLIENT_SECRET</code>, and <code>APP_ENCRYPTION_KEY</code>.
							</p>
						</div>
					{/if}
				</div>

				<div class="rounded-lg border border-base-300 bg-base-100 p-4">
					<div class="flex flex-wrap items-center justify-between gap-3">
						<div class="flex items-center gap-3">
							<div class="text-2xl">🔷</div>
							<div>
								<div class="font-semibold">Azure DevOps</div>
								{#if azureConnections.length > 0}
									<div class="text-sm opacity-70">
										Connected to {azureConnections.length} {azureConnections.length === 1 ? 'org' : 'orgs'}:
										{#each azureConnections as c, i (c.id)}
											<code>{c.providerAccount}</code>{i < azureConnections.length - 1 ? ', ' : ''}
										{/each}
										<span class="badge badge-success badge-xs ml-2">active</span>
									</div>
								{:else if azureRevoked.length > 0}
									<div class="text-sm opacity-70">
										Previously connected
										<span class="badge badge-error badge-xs ml-2">{azureRevoked[0].status}</span>
									</div>
								{:else}
									<div class="text-sm opacity-70">Not connected.</div>
								{/if}
							</div>
						</div>
						<div class="flex gap-2">
							{#if !overview.azureConfigured && azureConnections.length === 0}
								<span class="badge badge-warning badge-sm" title="Set AZURE_DEVOPS_OAUTH_CLIENT_ID + AZURE_DEVOPS_OAUTH_CLIENT_SECRET in env">
									Not configured
								</span>
							{:else if azureConnections.length > 0}
								<a class="btn btn-outline btn-xs" href="/source-control/azure-devops/connect">Reconnect</a>
								<button class="btn btn-error btn-outline btn-xs" type="button" onclick={disconnectAzure} disabled={busy}>
									Disconnect
								</button>
							{:else}
								<a class="btn btn-primary btn-xs" href="/source-control/azure-devops/connect">Connect</a>
							{/if}
						</div>
					</div>
					{#if !overview.azureConfigured && azureConnections.length === 0}
						<div class="mt-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs">
							<p class="font-semibold">Azure DevOps OAuth not configured.</p>
							<p class="mt-1 opacity-80">
								Register an app at <a class="link" href="https://app.vsaex.visualstudio.com/app/register" target="_blank" rel="noopener">app.vsaex.visualstudio.com/app/register</a>
								with callback <code>{`${page.url.origin}/source-control/azure-devops/callback`}</code> and the
								<code>vso.code_write</code> + <code>vso.profile</code> scopes, then set
								<code>AZURE_DEVOPS_OAUTH_CLIENT_ID</code> + <code>AZURE_DEVOPS_OAUTH_CLIENT_SECRET</code>.
							</p>
						</div>
					{/if}
				</div>
			</div>

			{#if errorMessage}
				<div class="alert alert-error mt-3 py-2 text-sm">{errorMessage}</div>
			{/if}

			<!-- ── Imported repository list ────────────────────────────────────── -->
			<div class="mt-4">
				<div class="mb-2 flex items-center justify-between">
					<h2 class="text-lg font-semibold">Imported repositories ({repos.length})</h2>
					{#if overview.legacySyncedCount > 0}
						<span class="text-xs opacity-60">
							{overview.legacySyncedCount} legacy bulk-synced rows hidden — re-import to surface them here.
						</span>
					{/if}
				</div>
				{#if repos.length === 0}
					<div class="rounded-lg border border-dashed border-base-300 bg-base-200/40 p-10 text-center">
						<p class="font-semibold">No repositories imported yet.</p>
						<p class="mt-1 text-sm opacity-70">
							Click <span class="font-mono">Import repository</span> to download a repo and auto-create a project for it.
						</p>
						<button class="btn btn-primary btn-sm mt-3" type="button" onclick={() => openImportModal('github')}>
							+ Import your first repo
						</button>
					</div>
				{:else}
					<ul class="space-y-2">
						{#each repos as repo (repo.id)}
							{@const localPath = metaField<string>(repo.metadata, 'localPath')}
							{@const htmlUrl = metaField<string>(repo.metadata, 'htmlUrl')}
							{@const lastImportedAt = metaField<string>(repo.metadata, 'lastImportedAt')}
							{@const lastPulledAt = metaField<string>(repo.metadata, 'lastPulledAt')}
							{@const expanded = openRepoId === repo.id}
							<li class="rounded-xl border border-base-300/60 bg-base-100 transition-colors hover:bg-base-200/30">
								<div class="flex flex-wrap items-center gap-3 p-3">
									<button
										type="button"
										class="flex-1 min-w-0 text-left"
										onclick={() => toggleRepoDetail(repo.id)}
										aria-expanded={expanded}
									>
										<div class="flex flex-wrap items-center gap-2">
											<span class="badge badge-sm {providerBadgeClass(repo.provider)}">{providerLabel(repo.provider)}</span>
											<span class="font-mono text-sm font-semibold">{repo.owner}/{repo.name}</span>
											<span class="badge badge-ghost badge-xs">{repo.defaultBranch}</span>
											{#if repo.projectId}
												<a
													href={projectHref(repo.projectId)}
													class="link link-hover text-xs opacity-70"
													onclick={(e) => e.stopPropagation()}
												>
													→ project
												</a>
											{/if}
										</div>
										<div class="mt-1 flex flex-wrap gap-3 text-xs opacity-55">
											<span>Imported {fmtRelative(lastImportedAt)}</span>
											{#if lastPulledAt}
												<span>· pulled {fmtRelative(lastPulledAt)}</span>
											{/if}
											{#if localPath}
												<span class="font-mono">· {localPath}</span>
											{/if}
										</div>
									</button>
									<div class="flex flex-shrink-0 gap-1">
										<button class="btn btn-ghost btn-xs" type="button" onclick={() => pullRepo(repo.id)} disabled={busy}>
											Pull latest
										</button>
										{#if htmlUrl}
											<a class="btn btn-ghost btn-xs" href={htmlUrl} target="_blank" rel="noopener">
												Open ↗
											</a>
										{/if}
										<button
											class="btn btn-ghost btn-xs text-error"
											type="button"
											onclick={() => detachRepo(repo)}
											disabled={busy}
										>
											Detach
										</button>
									</div>
								</div>

								{#if expanded}
									<div class="border-t border-base-300/60 p-3">
										{#if detailLoading}
											<p class="text-sm opacity-60">Loading details…</p>
										{:else if !repoDetail}
											<p class="text-sm text-error">Failed to load details.</p>
										{:else}
											<div class="grid gap-3 lg:grid-cols-3">
												<!-- Recent commits -->
												<section>
													<h3 class="mb-1 font-semibold text-sm">Recent commits</h3>
													{#if repoDetail.commits.length === 0}
														<p class="text-xs italic opacity-55">
															No commits yet — try Pull latest if the local clone is stale.
														</p>
													{:else}
														<ul class="space-y-1 text-xs">
															{#each repoDetail.commits as commit (commit.sha)}
																<li class="flex flex-col rounded-lg border border-base-300/60 bg-base-200/30 p-2">
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
												</section>

												<!-- Linked chats -->
												<section>
													<h3 class="mb-1 font-semibold text-sm">Linked chats</h3>
													{#if repoDetail.chats.length === 0}
														<p class="text-xs italic opacity-55">
															No chats linked yet. Start a chat and bind it to this project.
														</p>
													{:else}
														<ul class="space-y-1 text-xs">
															{#each repoDetail.chats as chat (chat.id)}
																<li class="rounded-lg border border-base-300/60 bg-base-200/30 p-2">
																	<a href={`/chat/${chat.id}`} class="link link-hover font-medium">
																		{chat.title}
																	</a>
																	<div class="text-[10px] opacity-55">
																		{chat.agentName ?? 'Chat'} · {fmtRelative(chat.updatedAt)}
																	</div>
																</li>
															{/each}
														</ul>
													{/if}
												</section>

												<!-- Recent PRs -->
												<section>
													<h3 class="mb-1 font-semibold text-sm">Recent PRs</h3>
													{#if repoDetail.pullRequests.length === 0}
														<p class="text-xs italic opacity-55">No pull requests recorded.</p>
													{:else}
														<ul class="space-y-1 text-xs">
															{#each repoDetail.pullRequests as pr (pr.id)}
																<li class="rounded-lg border border-base-300/60 bg-base-200/30 p-2">
																	<div class="flex flex-wrap items-center gap-1">
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
												</section>
											</div>
										{/if}
									</div>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		{/if}
	</div>
</div>

<!-- ── Import modal ──────────────────────────────────────────────────────────── -->
{#if importOpen}
	<div class="modal modal-open">
		<div class="modal-box max-w-3xl">
			<div class="mb-3 flex items-center justify-between">
				<h2 class="text-xl font-bold">Import repository</h2>
				<button class="btn btn-sm btn-ghost" type="button" onclick={closeImportModal} aria-label="Close">✕</button>
			</div>

			<div class="tabs tabs-bordered mb-3">
				<button
					type="button"
					class="tab {importTab === 'github' ? 'tab-active' : ''}"
					onclick={() => {
						importTab = 'github';
						if (githubCandidates.length === 0) loadGithubCandidates();
					}}
				>
					From GitHub
				</button>
				<button
					type="button"
					class="tab {importTab === 'azure' ? 'tab-active' : ''}"
					onclick={() => {
						importTab = 'azure';
						if (azureCandidates.length === 0) loadAzureCandidates();
					}}
				>
					From Azure DevOps
				</button>
				<button
					type="button"
					class="tab {importTab === 'url' ? 'tab-active' : ''}"
					onclick={() => (importTab = 'url')}
				>
					From URL
				</button>
			</div>

			<!-- Project picker (shared across tabs) -->
			<fieldset class="fieldset mb-3 rounded-lg border border-base-300/60 bg-base-200/30 p-3">
				<legend class="fieldset-legend text-xs">Project</legend>
				<div class="grid gap-2 sm:grid-cols-[1fr_2fr]">
					<select class="select select-sm select-bordered" bind:value={importProjectChoice}>
						<option value="auto">Auto-create new project</option>
						{#each projects as p (p.id)}
							<option value={p.id}>Existing: {p.name}</option>
						{/each}
					</select>
					{#if importProjectChoice === 'auto'}
						<input
							type="text"
							class="input input-sm input-bordered"
							bind:value={importProjectName}
							placeholder="Project name (defaults to owner/repo)"
							maxlength="120"
						/>
					{/if}
				</div>
			</fieldset>

			{#if importError}
				<div class="alert alert-error mb-3 py-2 text-xs">{importError}</div>
			{/if}

			{#if importTab === 'github'}
				{#if !githubConnection}
					<div class="alert alert-warning text-sm">
						<span>Connect GitHub first — <a class="link" href="/source-control/github/connect">connect now</a>.</span>
					</div>
				{:else}
					<div class="mb-2 flex items-center gap-2">
						<input
							type="search"
							class="input input-sm input-bordered flex-1"
							bind:value={githubFilter}
							placeholder="Filter by owner/repo…"
						/>
						<button type="button" class="btn btn-ghost btn-sm" onclick={loadGithubCandidates} disabled={githubLoading}>
							{githubLoading ? 'Loading…' : 'Refresh'}
						</button>
					</div>
					{#if githubError}
						<div class="alert alert-warning mb-2 py-2 text-xs">{githubError}</div>
					{/if}
					{#if githubLoading && githubCandidates.length === 0}
						<p class="py-6 text-center text-sm opacity-60">Loading repos…</p>
					{:else if filteredGithub.length === 0}
						<p class="py-6 text-center text-sm opacity-60">
							{githubFilter ? 'No matches.' : 'No repos available — try refreshing.'}
						</p>
					{:else}
						<ul class="max-h-96 space-y-1 overflow-y-auto">
							{#each filteredGithub.slice(0, 200) as cand (`${cand.owner}/${cand.name}`)}
								<li class="flex flex-wrap items-center gap-2 rounded-lg border border-base-300/60 bg-base-100 p-2">
									<div class="min-w-0 flex-1">
										<div class="flex flex-wrap items-center gap-2">
											<span class="font-mono text-sm font-semibold">{cand.owner}/{cand.name}</span>
											<span class="badge badge-xs {cand.private ? 'badge-warning' : 'badge-ghost'}">
												{cand.private ? 'private' : 'public'}
											</span>
											<code class="text-[10px] opacity-60">{cand.defaultBranch}</code>
										</div>
										{#if cand.description}
											<p class="line-clamp-1 text-xs opacity-65">{cand.description}</p>
										{/if}
									</div>
									{#if cand.alreadyImported}
										<span class="badge badge-success badge-sm">imported ✓</span>
									{:else}
										<button
											type="button"
											class="btn btn-primary btn-xs"
											onclick={() => importFromCandidate(cand.cloneUrl)}
											disabled={importBusy}
										>
											{importBusy ? '…' : 'Import'}
										</button>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
				{/if}
			{:else if importTab === 'azure'}
				{#if azureConnections.length === 0}
					<div class="alert alert-warning text-sm">
						<span>Connect Azure DevOps first — <a class="link" href="/source-control/azure-devops/connect">connect now</a>.</span>
					</div>
				{:else}
					<div class="mb-2 flex items-center gap-2">
						<input
							type="search"
							class="input input-sm input-bordered flex-1"
							bind:value={azureFilter}
							placeholder="Filter by org/project/repo…"
						/>
						<button type="button" class="btn btn-ghost btn-sm" onclick={loadAzureCandidates} disabled={azureLoading}>
							{azureLoading ? 'Loading…' : 'Refresh'}
						</button>
					</div>
					{#if azureError}
						<div class="alert alert-warning mb-2 py-2 text-xs">{azureError}</div>
					{/if}
					{#if azureLoading && azureCandidates.length === 0}
						<p class="py-6 text-center text-sm opacity-60">Loading repos…</p>
					{:else if filteredAzure.length === 0}
						<p class="py-6 text-center text-sm opacity-60">
							{azureFilter ? 'No matches.' : 'No repos available — try refreshing.'}
						</p>
					{:else}
						<ul class="max-h-96 space-y-1 overflow-y-auto">
							{#each filteredAzure.slice(0, 200) as cand (`${cand.org}/${cand.project}/${cand.name}`)}
								<li class="flex flex-wrap items-center gap-2 rounded-lg border border-base-300/60 bg-base-100 p-2">
									<div class="min-w-0 flex-1">
										<div class="flex flex-wrap items-center gap-2">
											<span class="font-mono text-sm font-semibold">{cand.org}/{cand.project}/{cand.name}</span>
											<code class="text-[10px] opacity-60">{cand.defaultBranch}</code>
										</div>
									</div>
									{#if cand.alreadyImported}
										<span class="badge badge-success badge-sm">imported ✓</span>
									{:else}
										<button
											type="button"
											class="btn btn-primary btn-xs"
											onclick={() => importFromCandidate(cand.cloneUrl)}
											disabled={importBusy}
										>
											{importBusy ? '…' : 'Import'}
										</button>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
				{/if}
			{:else}
				<form onsubmit={importFromUrl}>
					<fieldset class="fieldset">
						<legend class="fieldset-legend text-xs">Clone URL</legend>
						<input
							type="text"
							class="input input-bordered input-sm"
							bind:value={pasteUrl}
							placeholder="https://github.com/owner/repo  ·  https://dev.azure.com/org/project/_git/repo  ·  any clone URL"
							required
						/>
					</fieldset>
					{#if pastePreview}
						<p class="mt-1 text-xs opacity-60">Detected: <code>{pastePreview}</code></p>
					{:else if pasteUrl.trim()}
						<p class="mt-1 text-xs text-error">URL doesn't look like a clone URL.</p>
					{/if}
					<p class="mt-2 text-xs opacity-65">
						Public repos work without auth. Private GitHub requires the GitHub OAuth connection above; private Azure DevOps requires the Azure connection.
					</p>
					<div class="mt-3 flex justify-end gap-2">
						<button type="button" class="btn btn-ghost btn-sm" onclick={closeImportModal} disabled={importBusy}>Cancel</button>
						<button type="submit" class="btn btn-primary btn-sm" disabled={importBusy || !pasteUrl.trim()}>
							{importBusy ? 'Importing…' : 'Import'}
						</button>
					</div>
				</form>
			{/if}
		</div>
		<button class="modal-backdrop" type="button" onclick={closeImportModal} aria-label="Close modal"></button>
	</div>
{/if}
