<svelte:head><title>Projects | AgentStudio</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import {
		listProjectsQuery,
		createProjectCommand,
		deleteProjectCommand,
		getProjectsOverviewQuery,
		disconnectGithubCommand,
		disconnectAzureCommand,
		listGithubImportCandidatesQuery,
		listAzureImportCandidatesQuery,
	} from '$lib/projects/projects.remote';
	import PageHeader from '$lib/ui/PageHeader.svelte';

	type ProjectRow = Awaited<ReturnType<typeof listProjectsQuery>>[number];
	type Overview = Awaited<ReturnType<typeof getProjectsOverviewQuery>>;
	type GithubCandidate = Awaited<ReturnType<typeof listGithubImportCandidatesQuery>>['candidates'][number];
	type AzureCandidate = Awaited<ReturnType<typeof listAzureImportCandidatesQuery>>['candidates'][number];

	type RepoMode = 'none' | 'local' | 'github' | 'azure' | 'url';

	let projects = $state<ProjectRow[]>([]);
	let overview = $state<Overview | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);

	// Creation modal state
	let modalOpen = $state(false);
	let modalTab = $state<RepoMode>('none');
	let creating = $state(false);
	let formError = $state<string | null>(null);
	let formName = $state('');
	let formKind = $state<ProjectRow['kind']>('other');
	let formDescription = $state('');
	let formDefaultBranch = $state('main');
	let formCloneUrl = $state('');
	let githubCandidates = $state<GithubCandidate[]>([]);
	let githubLoading = $state(false);
	let githubError = $state<string | null>(null);
	let githubFilter = $state('');
	let azureCandidates = $state<AzureCandidate[]>([]);
	let azureLoading = $state(false);
	let azureError = $state<string | null>(null);
	let azureFilter = $state('');

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

	const KINDS: Array<{ value: ProjectRow['kind']; label: string }> = [
		{ value: 'efoil', label: 'Efoil' },
		{ value: 'research', label: 'Research' },
		{ value: 'code', label: 'Code' },
		{ value: 'documentation', label: 'Documentation' },
		{ value: 'other', label: 'Other' },
	];

	const TAB_LABELS: Record<RepoMode, string> = {
		none: 'Empty',
		local: 'Local repo',
		github: 'From GitHub',
		azure: 'From Azure',
		url: 'From URL',
	};

	const filteredGithub = $derived(
		githubFilter.trim()
			? githubCandidates.filter((c) =>
					`${c.owner}/${c.name}`.toLowerCase().includes(githubFilter.toLowerCase()),
				)
			: githubCandidates,
	);
	const filteredAzure = $derived(
		azureFilter.trim()
			? azureCandidates.filter((c) =>
					`${c.org}/${c.project}/${c.name}`.toLowerCase().includes(azureFilter.toLowerCase()),
				)
			: azureCandidates,
	);

	onMount(() => void load());

	async function load() {
		loading = true;
		error = null;
		try {
			[projects, overview] = await Promise.all([listProjectsQuery(), getProjectsOverviewQuery()]);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load projects';
		} finally {
			loading = false;
		}
	}

	function openModal(tab: RepoMode = 'none') {
		modalOpen = true;
		modalTab = tab;
		formError = null;
		formName = '';
		formKind = 'other';
		formDescription = '';
		formDefaultBranch = 'main';
		formCloneUrl = '';
		if (tab === 'github' && githubCandidates.length === 0) loadGithubCandidates();
		if (tab === 'azure' && azureCandidates.length === 0) loadAzureCandidates();
	}

	function closeModal() {
		modalOpen = false;
	}

	async function loadGithubCandidates() {
		githubLoading = true;
		githubError = null;
		try {
			const res = await listGithubImportCandidatesQuery();
			githubCandidates = res.candidates;
			if (res.errorMessage) githubError = res.errorMessage;
		} catch (e) {
			githubError = e instanceof Error ? e.message : 'Failed to load GitHub repos';
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
		} catch (e) {
			azureError = e instanceof Error ? e.message : 'Failed to load Azure repos';
		} finally {
			azureLoading = false;
		}
	}

	function deriveNameFromUrl(url: string): string {
		const match = url.match(/[/:]([^/:]+?)(?:\.git)?\/?$/);
		return match ? match[1] : 'New project';
	}

	async function submitCreate(input: Parameters<typeof createProjectCommand>[0]) {
		creating = true;
		formError = null;
		try {
			await createProjectCommand(input);
			modalOpen = false;
			await load();
		} catch (e) {
			formError = e instanceof Error ? e.message : 'Failed to create project';
		} finally {
			creating = false;
		}
	}

	async function submitEmpty(event: Event) {
		event.preventDefault();
		const name = formName.trim();
		if (!name) { formError = 'Name required'; return; }
		await submitCreate({
			name,
			kind: formKind,
			description: formDescription.trim() || undefined,
			repoMode: 'none',
		});
	}

	async function submitLocal(event: Event) {
		event.preventDefault();
		const name = formName.trim();
		if (!name) { formError = 'Name required'; return; }
		await submitCreate({
			name,
			kind: formKind,
			description: formDescription.trim() || undefined,
			repoMode: 'local',
			defaultBranch: formDefaultBranch.trim() || undefined,
		});
	}

	async function submitGithub(cand: GithubCandidate) {
		await submitCreate({
			name: formName.trim() || `${cand.owner}/${cand.name}`,
			kind: 'code',
			description: formDescription.trim() || cand.description || undefined,
			repoMode: 'imported',
			source: { type: 'github', owner: cand.owner, repo: cand.name, cloneUrl: cand.cloneUrl },
		});
	}

	async function submitAzure(cand: AzureCandidate) {
		await submitCreate({
			name: formName.trim() || `${cand.org}/${cand.name}`,
			kind: 'code',
			description: formDescription.trim() || undefined,
			repoMode: 'imported',
			source: {
				type: 'azure',
				org: cand.org,
				project: cand.project,
				repo: cand.name,
				cloneUrl: cand.cloneUrl,
			},
		});
	}

	async function submitUrl(event: Event) {
		event.preventDefault();
		const url = formCloneUrl.trim();
		if (!url) { formError = 'Clone URL required'; return; }
		await submitCreate({
			name: formName.trim() || deriveNameFromUrl(url),
			kind: 'code',
			description: formDescription.trim() || undefined,
			repoMode: 'imported',
			source: { type: 'url', cloneUrl: url },
		});
	}

	async function handleDelete(project: ProjectRow) {
		const fsNote = project.repoKind !== 'none' ? ' Filesystem and git repo will also be removed.' : '';
		if (!confirm(`Delete "${project.name}"?${fsNote} All artifacts and versions will be lost.`)) return;
		try {
			await deleteProjectCommand(project.id);
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to delete project';
		}
	}

	async function disconnectGithub() {
		if (!confirm('Disconnect GitHub? Your stored token will be revoked. Imported projects keep their local clone.')) return;
		try {
			await disconnectGithubCommand();
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Disconnect failed';
		}
	}

	async function disconnectAzure() {
		if (!confirm('Disconnect all Azure DevOps connections? Imported projects keep their local clone.')) return;
		try {
			await disconnectAzureCommand();
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Disconnect failed';
		}
	}

	function fmtDate(d: Date | string) {
		return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
	}

	function kindTone(kind: string): string {
		switch (kind) {
			case 'code': return 'badge-info';
			case 'research': return 'badge-secondary';
			case 'documentation': return 'badge-warning';
			case 'efoil': return 'badge-primary';
			default: return 'badge-ghost';
		}
	}

	function repoBadge(repoKind: string) {
		if (repoKind === 'local') return { tone: 'badge-ghost', label: 'local' };
		if (repoKind === 'imported') return { tone: 'badge-success', label: 'imported' };
		return null;
	}
</script>

<div class="flex h-full min-h-0 flex-col">
	<PageHeader title="Projects" subtitle={`${projects.length} project${projects.length !== 1 ? 's' : ''}`}>
		{#snippet actions()}
			<button class="btn btn-xs btn-primary" type="button" onclick={() => openModal('none')}>
				+ New project
			</button>
		{/snippet}
	</PageHeader>

	<div class="min-h-0 flex-1 overflow-y-auto px-3 py-3 tablet:px-4 desktop:px-4 desktop:py-4 space-y-3 sm:space-y-4">

		{#if errorParam}
			<div class="alert alert-error text-sm">
				<span>OAuth error: <code>{errorParam}</code>. Try connecting again.</span>
			</div>
		{/if}

		<!-- ── Connections ──────────────────────────────────────────────── -->
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
							{:else if githubRevoked}
								<div class="text-sm opacity-70">
									Previously connected as <code>{githubRevoked.providerAccount}</code>
									<span class="badge badge-error badge-xs ml-2">{githubRevoked.status}</span>
								</div>
							{:else}
								<div class="text-sm opacity-70">Not connected.</div>
							{/if}
						</div>
					</div>
					<div class="flex gap-2">
						{#if !overview?.githubConfigured && !githubConnection}
							<span class="badge badge-warning badge-sm" title="Set GITHUB_OAUTH_CLIENT_ID + GITHUB_OAUTH_CLIENT_SECRET in env">
								Not configured
							</span>
						{:else if githubConnection}
							<a class="btn btn-outline btn-xs" href="/source-control/github/connect">Reconnect</a>
							<button class="btn btn-error btn-outline btn-xs" type="button" onclick={disconnectGithub}>
								Disconnect
							</button>
						{:else}
							<a class="btn btn-primary btn-xs" href="/source-control/github/connect">Connect</a>
						{/if}
					</div>
				</div>
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
								</div>
							{:else}
								<div class="text-sm opacity-70">Not connected.</div>
							{/if}
						</div>
					</div>
					<div class="flex gap-2">
						{#if !overview?.azureConfigured && azureConnections.length === 0}
							<span class="badge badge-warning badge-sm" title="Set AZURE_DEVOPS_OAUTH_CLIENT_ID + AZURE_DEVOPS_OAUTH_CLIENT_SECRET in env">
								Not configured
							</span>
						{:else if azureConnections.length > 0}
							<a class="btn btn-outline btn-xs" href="/source-control/azure-devops/connect">Reconnect</a>
							<button class="btn btn-error btn-outline btn-xs" type="button" onclick={disconnectAzure}>
								Disconnect
							</button>
						{:else}
							<a class="btn btn-primary btn-xs" href="/source-control/azure-devops/connect">Connect</a>
						{/if}
					</div>
				</div>
			</div>
		</div>

		{#if loading}
			<div class="flex justify-center py-20">
				<span class="loading loading-spinner loading-lg text-primary"></span>
			</div>
		{:else if error}
			<div class="alert alert-error text-sm">{error}</div>
		{:else if projects.length === 0}
			<div class="card card-body bg-base-200/30 border-base-300/60 rounded-2xl border p-12 text-center text-sm text-base-content/55">
				No projects yet. Click <span class="font-mono">+ New project</span> above to start.
			</div>
		{:else}
			<div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
				{#each projects as project (project.id)}
					{@const rb = repoBadge(project.repoKind)}
					<div class="group flex flex-col gap-2 rounded-xl border border-base-300/60 bg-base-100 p-3 transition-colors hover:bg-base-200/40">
						<div class="flex items-start justify-between gap-2">
							<a href="/projects/{project.id}" class="min-w-0 flex-1">
								<p class="line-clamp-1 font-semibold leading-tight">{project.name}</p>
								<p class="font-mono text-[10px] text-base-content/50">/{project.slug}</p>
							</a>
							<div class="flex flex-col items-end gap-1">
								<span class="badge badge-xs {kindTone(project.kind)}">{project.kind}</span>
								{#if rb}
									<span class="badge badge-xs {rb.tone}">{rb.label}</span>
								{/if}
							</div>
						</div>
						{#if project.description}
							<p class="line-clamp-2 text-xs text-base-content/65">{project.description}</p>
						{/if}
						<div class="flex items-center justify-between text-xs text-base-content/45">
							<span>Updated {fmtDate(project.updatedAt)}</span>
							<button
								class="btn btn-xs btn-ghost text-error opacity-50 hover:opacity-100"
								type="button"
								onclick={() => handleDelete(project)}
								aria-label="Delete project"
							>
								Delete
							</button>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>

<!-- ── Create modal ────────────────────────────────────────────── -->
{#if modalOpen}
	<div class="modal modal-open">
		<div class="modal-box max-w-3xl">
			<div class="mb-3 flex items-center justify-between">
				<h2 class="text-xl font-bold">New project</h2>
				<button class="btn btn-sm btn-ghost" type="button" onclick={closeModal} aria-label="Close">✕</button>
			</div>

			<div class="tabs tabs-bordered mb-3 flex-wrap">
				{#each (['none', 'local', 'github', 'azure', 'url'] as RepoMode[]) as tab (tab)}
					<button
						type="button"
						class="tab {modalTab === tab ? 'tab-active' : ''}"
						onclick={() => {
							modalTab = tab;
							formError = null;
							if (tab === 'github' && githubCandidates.length === 0) loadGithubCandidates();
							if (tab === 'azure' && azureCandidates.length === 0) loadAzureCandidates();
						}}
					>
						{TAB_LABELS[tab]}
					</button>
				{/each}
			</div>

			{#if formError}
				<div class="alert alert-error mb-3 py-2 text-xs">{formError}</div>
			{/if}

			<!-- Shared name/kind/description fieldset -->
			<div class="grid gap-2 mb-3 sm:grid-cols-2">
				<fieldset class="fieldset">
					<legend class="fieldset-legend text-xs">Name {modalTab === 'github' || modalTab === 'azure' ? '(optional, defaults to repo name)' : ''}</legend>
					<input
						type="text"
						class="input input-sm input-bordered"
						bind:value={formName}
						placeholder={modalTab === 'github' || modalTab === 'azure' ? 'owner/repo' : 'e.g. Efoil Rebuild'}
						maxlength="120"
					/>
				</fieldset>
				<fieldset class="fieldset">
					<legend class="fieldset-legend text-xs">Kind</legend>
					<select class="select select-sm select-bordered" bind:value={formKind}>
						{#each KINDS as k (k.value)}
							<option value={k.value}>{k.label}</option>
						{/each}
					</select>
				</fieldset>
			</div>
			<fieldset class="fieldset mb-3">
				<legend class="fieldset-legend text-xs">Description (optional)</legend>
				<textarea
					class="textarea textarea-bordered textarea-sm"
					bind:value={formDescription}
					placeholder="What is this project for?"
					maxlength="1000"
					rows="2"
				></textarea>
			</fieldset>

			{#if modalTab === 'none'}
				<form onsubmit={submitEmpty}>
					<p class="mb-3 text-xs opacity-65">
						Creates a project with no filesystem footprint. Add artifacts manually; no git repo on disk.
					</p>
					<div class="flex justify-end gap-2">
						<button type="button" class="btn btn-ghost btn-sm" onclick={closeModal} disabled={creating}>Cancel</button>
						<button type="submit" class="btn btn-primary btn-sm" disabled={creating}>
							{creating ? 'Creating…' : 'Create empty project'}
						</button>
					</div>
				</form>
			{:else if modalTab === 'local'}
				<form onsubmit={submitLocal}>
					<fieldset class="fieldset mb-3">
						<legend class="fieldset-legend text-xs">Default branch</legend>
						<input
							type="text"
							class="input input-sm input-bordered"
							bind:value={formDefaultBranch}
							placeholder="main"
							maxlength="120"
						/>
					</fieldset>
					<p class="mb-3 text-xs opacity-65">
						`git init`'s a fresh repo at the project's sandbox path with a README and an initial commit.
						No remote — push later by adding one manually or by linking from the project page.
					</p>
					<div class="flex justify-end gap-2">
						<button type="button" class="btn btn-ghost btn-sm" onclick={closeModal} disabled={creating}>Cancel</button>
						<button type="submit" class="btn btn-primary btn-sm" disabled={creating}>
							{creating ? 'Creating…' : 'Create local project'}
						</button>
					</div>
				</form>
			{:else if modalTab === 'github'}
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
									<button
										type="button"
										class="btn btn-primary btn-xs"
										onclick={() => submitGithub(cand)}
										disabled={creating}
									>
										{creating ? '…' : 'Clone & create'}
									</button>
								</li>
							{/each}
						</ul>
					{/if}
				{/if}
			{:else if modalTab === 'azure'}
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
									<button
										type="button"
										class="btn btn-primary btn-xs"
										onclick={() => submitAzure(cand)}
										disabled={creating}
									>
										{creating ? '…' : 'Clone & create'}
									</button>
								</li>
							{/each}
						</ul>
					{/if}
				{/if}
			{:else if modalTab === 'url'}
				<form onsubmit={submitUrl}>
					<fieldset class="fieldset mb-3">
						<legend class="fieldset-legend text-xs">Clone URL</legend>
						<input
							type="text"
							class="input input-sm input-bordered"
							bind:value={formCloneUrl}
							placeholder="https://github.com/owner/repo · https://dev.azure.com/org/project/_git/repo · any clone URL"
							required
						/>
					</fieldset>
					<p class="mb-3 text-xs opacity-65">
						Public repos work without auth. Private GitHub requires the GitHub OAuth connection above; private
						Azure DevOps requires the Azure connection.
					</p>
					<div class="flex justify-end gap-2">
						<button type="button" class="btn btn-ghost btn-sm" onclick={closeModal} disabled={creating}>Cancel</button>
						<button type="submit" class="btn btn-primary btn-sm" disabled={creating || !formCloneUrl.trim()}>
							{creating ? 'Cloning…' : 'Clone & create'}
						</button>
					</div>
				</form>
			{/if}
		</div>
		<button class="modal-backdrop" type="button" onclick={closeModal} aria-label="Close modal"></button>
	</div>
{/if}
