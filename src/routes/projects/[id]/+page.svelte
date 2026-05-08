<svelte:head><title>{detail?.project.name ?? 'Project'} | AgentStudio</title></svelte:head>

<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import {
		getProjectByIdQuery,
		createArtifactCommand,
		softDeleteArtifactCommand,
	} from '$lib/projects/projects.remote';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';

	type Detail = NonNullable<Awaited<ReturnType<typeof getProjectByIdQuery>>>;

	const projectId = $derived(page.params.id ?? '');

	let detail = $state<Detail | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);

	let formOpen = $state(false);
	let formName = $state('');
	let formContent = $state('');
	let formContentType = $state<'markdown' | 'code' | 'json' | 'yaml' | 'plaintext'>('markdown');
	let formError = $state<string | null>(null);
	let creating = $state(false);

	const CONTENT_TYPES: Array<{ value: typeof formContentType; label: string }> = [
		{ value: 'markdown', label: 'Markdown' },
		{ value: 'code', label: 'Code' },
		{ value: 'json', label: 'JSON' },
		{ value: 'yaml', label: 'YAML' },
		{ value: 'plaintext', label: 'Plain text' },
	];

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
			await createArtifactCommand({
				projectId,
				name,
				content: formContent,
				contentType: formContentType,
			});
			formName = '';
			formContent = '';
			formContentType = 'markdown';
			formOpen = false;
			await load();
		} catch (e) {
			formError = e instanceof Error ? e.message : 'Failed to create artifact';
		} finally {
			creating = false;
		}
	}

	async function handleDelete(artifactId: string, name: string) {
		if (!confirm(`Soft-delete "${name}"? Versions are preserved; the artifact stops appearing in the active list.`)) return;
		try {
			await softDeleteArtifactCommand(artifactId);
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to delete artifact';
		}
	}

	function fmtDate(d: Date | string) {
		return new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
	}
</script>

<div class="flex h-full min-h-0 flex-col">
	<PageHeader
		title={detail?.project.name ?? 'Project'}
		crumbs={[{ label: 'Projects', href: '/projects' }]}
		backHref="/projects"
		subtitle={detail ? `/${detail.project.slug} · ${detail.project.kind}` : ''}
	>
		{#snippet actions()}
			{#if detail}
				<button class="btn btn-xs btn-primary" type="button" onclick={() => (formOpen = !formOpen)}>
					{formOpen ? 'Cancel' : '+ New artifact'}
				</button>
			{/if}
		{/snippet}
	</PageHeader>

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

		<ContentPanel>
			{#snippet header()}
				<div class="flex flex-1 flex-wrap items-start justify-between gap-2">
					<div class="min-w-0 flex-1">
						{#if p.description}
							<p class="text-sm text-base-content/70">{p.description}</p>
						{/if}
					</div>
				</div>
			{/snippet}

			{#if formOpen}
				<form class="mt-3 grid gap-2 rounded-xl border border-base-300/60 bg-base-200/40 p-3 text-sm" onsubmit={submitCreate}>
					<div class="grid gap-2 sm:grid-cols-[2fr_1fr]">
						<fieldset class="fieldset">
							<legend class="fieldset-legend text-xs">Name</legend>
							<input
								type="text"
								class="input input-sm input-bordered"
								bind:value={formName}
								placeholder="e.g. Hydrofoil Assembly Guide"
								maxlength="160"
								required
							/>
						</fieldset>
						<fieldset class="fieldset">
							<legend class="fieldset-legend text-xs">Content type</legend>
							<select class="select select-sm select-bordered" bind:value={formContentType}>
								{#each CONTENT_TYPES as t (t.value)}
									<option value={t.value}>{t.label}</option>
								{/each}
							</select>
						</fieldset>
					</div>
					<fieldset class="fieldset">
						<legend class="fieldset-legend text-xs">Initial content (will be saved as v1)</legend>
						<textarea
							class="textarea textarea-bordered font-mono text-xs"
							bind:value={formContent}
							placeholder="Type or paste content here…"
							rows="8"
						></textarea>
					</fieldset>
					{#if formError}
						<div class="alert alert-error py-2 text-xs">{formError}</div>
					{/if}
					<div class="flex justify-end gap-2">
						<button type="button" class="btn btn-xs btn-ghost" onclick={() => (formOpen = false)} disabled={creating}>
							Cancel
						</button>
						<button type="submit" class="btn btn-xs btn-primary" disabled={creating}>
							{creating ? 'Creating…' : 'Create artifact'}
						</button>
					</div>
				</form>
			{/if}
		</ContentPanel>

		<ContentPanel>
			{#snippet header()}
				<div class="flex flex-1 items-center justify-between gap-2">
					<h2 class="font-semibold">Artifacts</h2>
					<span class="badge badge-sm badge-ghost">{detail?.artifacts.length ?? 0}</span>
				</div>
			{/snippet}
			{#if detail.artifacts.length === 0}
				<p class="py-6 text-center text-sm italic text-base-content/45">
					No artifacts yet. Create one above to start version-tracking content.
				</p>
			{:else}
				<ul class="space-y-2">
					{#each detail.artifacts as a (a.id)}
						<li class="group flex items-center gap-2 rounded-xl border border-base-300/60 bg-base-100 p-3">
							<div class="min-w-0 flex-1">
								<a href="/projects/{p.id}/artifacts/{a.id}" class="link link-hover font-medium">{a.name}</a>
								<p class="font-mono text-[10px] text-base-content/45">
									/{a.slug} · {a.contentType} · updated {fmtDate(a.updatedAt)}
								</p>
							</div>
							<button
								class="btn btn-xs btn-ghost text-error opacity-50 hover:opacity-100"
								type="button"
								onclick={() => handleDelete(a.id, a.name)}
							>
								Soft delete
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</ContentPanel>
	</section>
{/if}
	</div>
</div>
