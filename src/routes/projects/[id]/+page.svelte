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

{#if loading}
	<div class="flex justify-center py-20">
		<span class="loading loading-spinner loading-lg text-primary"></span>
	</div>
{:else if error || !detail}
	<div class="py-20 text-center text-sm text-base-content/55">{error ?? 'Project not found.'}</div>
{:else}
	{@const p = detail.project}
	<section class="space-y-3 sm:space-y-4">
		<a class="btn btn-sm btn-ghost -ml-1 w-fit" href="/projects">← All projects</a>

		<ContentPanel>
			{#snippet header()}
				<div class="flex flex-1 flex-wrap items-start justify-between gap-2">
					<div class="min-w-0 flex-1">
						<h1 class="text-lg font-bold leading-tight sm:text-2xl">{p.name}</h1>
						<p class="mt-0.5 font-mono text-xs text-base-content/55">/{p.slug} · {p.kind}</p>
						{#if p.description}
							<p class="mt-1 text-sm text-base-content/70">{p.description}</p>
						{/if}
					</div>
					<button class="btn btn-sm btn-primary" type="button" onclick={() => (formOpen = !formOpen)}>
						{formOpen ? 'Cancel' : '+ New artifact'}
					</button>
				</div>
			{/snippet}

			{#if formOpen}
				<form class="mt-3 grid gap-2 rounded-xl border border-base-300/60 bg-base-200/40 p-3 text-sm" onsubmit={submitCreate}>
					<div class="grid gap-2 sm:grid-cols-[2fr_1fr]">
						<label class="form-control">
							<span class="label-text text-xs">Name</span>
							<input
								type="text"
								class="input input-sm input-bordered"
								bind:value={formName}
								placeholder="e.g. Hydrofoil Assembly Guide"
								maxlength="160"
								required
							/>
						</label>
						<label class="form-control">
							<span class="label-text text-xs">Content type</span>
							<select class="select select-sm select-bordered" bind:value={formContentType}>
								{#each CONTENT_TYPES as t (t.value)}
									<option value={t.value}>{t.label}</option>
								{/each}
							</select>
						</label>
					</div>
					<label class="form-control">
						<span class="label-text text-xs">Initial content (will be saved as v1)</span>
						<textarea
							class="textarea textarea-bordered font-mono text-xs"
							bind:value={formContent}
							placeholder="Type or paste content here…"
							rows="8"
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
								class="invisible btn btn-xs btn-ghost text-error group-hover:visible"
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
