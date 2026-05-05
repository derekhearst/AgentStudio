<svelte:head><title>Projects | AgentStudio</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import {
		listProjectsQuery,
		createProjectCommand,
		deleteProjectCommand,
	} from '$lib/projects/projects.remote';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';

	type ProjectRow = Awaited<ReturnType<typeof listProjectsQuery>>[number];

	let projects = $state<ProjectRow[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let creating = $state(false);
	let formOpen = $state(false);
	let formName = $state('');
	let formKind = $state<ProjectRow['kind']>('other');
	let formDescription = $state('');
	let formError = $state<string | null>(null);

	const KINDS: Array<{ value: ProjectRow['kind']; label: string }> = [
		{ value: 'efoil', label: 'Efoil' },
		{ value: 'research', label: 'Research' },
		{ value: 'code', label: 'Code' },
		{ value: 'documentation', label: 'Documentation' },
		{ value: 'other', label: 'Other' },
	];

	onMount(() => void load());

	async function load() {
		loading = true;
		error = null;
		try {
			projects = await listProjectsQuery();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load projects';
		} finally {
			loading = false;
		}
	}

	async function submitCreate(event: Event) {
		event.preventDefault();
		const name = formName.trim();
		if (!name) {
			formError = 'Name required';
			return;
		}
		creating = true;
		formError = null;
		try {
			await createProjectCommand({
				name,
				kind: formKind,
				description: formDescription.trim() || undefined,
			});
			formName = '';
			formDescription = '';
			formKind = 'other';
			formOpen = false;
			await load();
		} catch (e) {
			formError = e instanceof Error ? e.message : 'Failed to create project';
		} finally {
			creating = false;
		}
	}

	async function handleDelete(project: ProjectRow) {
		if (!confirm(`Delete "${project.name}"? All artifacts and versions will be removed.`)) return;
		try {
			await deleteProjectCommand(project.id);
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to delete project';
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
</script>

<div class="flex h-full min-h-0 flex-col space-y-3 sm:space-y-4">
	<ContentPanel>
		{#snippet header()}
			<div class="flex flex-1 flex-wrap items-center justify-between gap-2">
				<div>
					<h1 class="text-xl font-bold sm:text-3xl">Projects</h1>
					<p class="text-xs text-base-content/70 sm:text-sm">
						Durable containers for artifacts with append-only version history.
					</p>
				</div>
				<button class="btn btn-sm btn-primary" type="button" onclick={() => (formOpen = !formOpen)}>
					{formOpen ? 'Cancel' : '+ New project'}
				</button>
			</div>
		{/snippet}

		{#if formOpen}
			<form class="mt-3 grid gap-2 rounded-xl border border-base-300/60 bg-base-200/40 p-3 text-sm" onsubmit={submitCreate}>
				<div class="grid gap-2 sm:grid-cols-2">
					<label class="form-control">
						<span class="label-text text-xs">Name</span>
						<input
							type="text"
							class="input input-sm input-bordered"
							bind:value={formName}
							placeholder="e.g. Efoil Rebuild"
							maxlength="120"
							required
						/>
					</label>
					<label class="form-control">
						<span class="label-text text-xs">Kind</span>
						<select class="select select-sm select-bordered" bind:value={formKind}>
							{#each KINDS as k (k.value)}
								<option value={k.value}>{k.label}</option>
							{/each}
						</select>
					</label>
				</div>
				<label class="form-control">
					<span class="label-text text-xs">Description (optional)</span>
					<textarea
						class="textarea textarea-bordered textarea-sm"
						bind:value={formDescription}
						placeholder="What is this project for?"
						maxlength="1000"
						rows="2"
					></textarea>
				</label>
				{#if formError}
					<div class="alert alert-error py-2 text-xs">{formError}</div>
				{/if}
				<div class="flex justify-end gap-2">
					<button type="button" class="btn btn-xs btn-ghost" onclick={() => (formOpen = false)} disabled={creating}>
						Cancel
					</button>
					<button type="submit" class="btn btn-xs btn-primary" disabled={creating}>
						{creating ? 'Creating…' : 'Create'}
					</button>
				</div>
			</form>
		{/if}
	</ContentPanel>

	{#if loading}
		<div class="flex justify-center py-20">
			<span class="loading loading-spinner loading-lg text-primary"></span>
		</div>
	{:else if error}
		<div class="alert alert-error text-sm">{error}</div>
	{:else if projects.length === 0}
		<div class="rounded-2xl border border-base-300/60 bg-base-200/30 p-12 text-center text-sm text-base-content/55">
			No projects yet. Create one to start grouping artifacts with version history.
		</div>
	{:else}
		<div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
			{#each projects as project (project.id)}
				<div class="group flex flex-col gap-2 rounded-xl border border-base-300/60 bg-base-100 p-3 transition-colors hover:bg-base-200/40">
					<div class="flex items-start justify-between gap-2">
						<a href="/projects/{project.id}" class="min-w-0 flex-1">
							<p class="line-clamp-1 font-semibold leading-tight">{project.name}</p>
							<p class="font-mono text-[10px] text-base-content/50">/{project.slug}</p>
						</a>
						<span class="badge badge-xs {kindTone(project.kind)}">{project.kind}</span>
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
