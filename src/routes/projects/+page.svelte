<svelte:head><title>Projects | AgentStudio</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import {
		listProjectsQuery,
		deleteProjectCommand,
		getProjectsOverviewQuery,
		disconnectGithubCommand,
		disconnectAzureCommand,
	} from '$lib/projects/projects.remote';
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import ConnectionsPanel from '$lib/projects/components/ConnectionsPanel.svelte';
	import ProjectGridItem from '$lib/projects/components/ProjectGridItem.svelte';
	import CreateProjectModal from '$lib/projects/components/CreateProjectModal.svelte';

	type ProjectRow = Awaited<ReturnType<typeof listProjectsQuery>>[number];
	type Overview = Awaited<ReturnType<typeof getProjectsOverviewQuery>>;
	type RepoMode = 'none' | 'local' | 'github' | 'azure' | 'url';

	let projects = $state<ProjectRow[]>([]);
	let overview = $state<Overview | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);

	let modalOpen = $state(false);
	let modalInitialTab = $state<RepoMode>('none');

	const errorParam = $derived(page.url.searchParams.get('error'));
	const githubAvailable = $derived(
		overview?.connections.some((c) => c.provider === 'github' && c.status === 'active') ?? false,
	);
	const azureAvailable = $derived(
		overview?.connections.some((c) => c.provider === 'azure_devops' && c.status === 'active') ?? false,
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
		modalInitialTab = tab;
		modalOpen = true;
	}

	function closeModal() {
		modalOpen = false;
	}

	async function handleProjectCreated() {
		modalOpen = false;
		await load();
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
		<ConnectionsPanel
			{overview}
			onDisconnectGithub={disconnectGithub}
			onDisconnectAzure={disconnectAzure}
		/>

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
					<ProjectGridItem {project} onDelete={handleDelete} />
				{/each}
			</div>
		{/if}
	</div>
</div>

<CreateProjectModal
	open={modalOpen}
	initialTab={modalInitialTab}
	{githubAvailable}
	{azureAvailable}
	onCreated={handleProjectCreated}
	onClose={closeModal}
/>
