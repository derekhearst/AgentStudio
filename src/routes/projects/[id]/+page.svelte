<svelte:head><title>{detail?.project.name ?? 'Project'} | AgentStudio</title></svelte:head>

<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { getProjectByIdQuery } from '$lib/projects/projects.remote';
	import EmptyState from '$lib/ui/EmptyState.svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import RepoTab from '$lib/projects/components/RepoTab.svelte';
	import ProjectTrustPanel from '$lib/projects/components/ProjectTrustPanel.svelte';
	import ProjectInstructionsPanel from '$lib/projects/components/ProjectInstructionsPanel.svelte';

	type Detail = NonNullable<Awaited<ReturnType<typeof getProjectByIdQuery>>>;

	const projectId = $derived(page.params.id ?? '');

	let detail = $state<Detail | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);

	const repoKind = $derived(detail?.project.repoKind ?? 'none');
	const hasRepo = $derived(repoKind !== 'none');

	onMount(() => void load());

	async function load() {
		loading = true;
		error = null;
		try {
			detail = await getProjectByIdQuery(projectId);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load project';
		} finally {
			loading = false;
		}
	}
</script>

<div class="flex h-full min-h-0 flex-col">
	<PageHeader
		title={detail?.project.name ?? 'Project'}
		crumbs={[{ label: 'Projects', href: '/projects' }]}
		backHref="/projects"
		subtitle={detail ? `/${detail.project.slug} · ${detail.project.kind}${hasRepo ? ` · ${detail.project.repoKind}` : ''}` : ''}
	/>

	<div class="min-h-0 flex-1 overflow-y-auto px-3 py-3 tablet:px-4 desktop:px-4 desktop:py-4">

{#if loading}
	<div class="flex justify-center py-20">
		<span class="loading loading-spinner loading-lg text-primary"></span>
	</div>
{:else if error || !detail}
	<div class="py-20 text-center text-sm text-base-content/55">{error ?? 'Project not found.'}</div>
{:else}
	{@const p = detail.project}
	<section class="space-y-3 sm:space-y-4">

		{#if p.description}
			<p class="text-sm text-base-content/70">{p.description}</p>
		{/if}

		<ProjectInstructionsPanel
			{projectId}
			instructions={p.instructions}
			trusted={p.settingsTrusted}
			onChanged={(next) => {
				if (detail) detail.project.instructions = next;
			}}
		/>

		<ProjectTrustPanel
			{projectId}
			{repoKind}
			trusted={p.settingsTrusted}
			onChanged={(next) => {
				if (detail) detail.project.settingsTrusted = next;
			}}
		/>

		{#if hasRepo}
			<RepoTab {projectId} {repoKind} />
		{:else}
			<EmptyState
				title="No repository"
				hint="Import or initialise a repo to give the agent somewhere to write."
			/>
		{/if}
	</section>
{/if}
	</div>
</div>
