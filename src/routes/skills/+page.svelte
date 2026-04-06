<svelte:head><title>Skills | DrokBot</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import {
		listSkillsQuery,
		createSkillCommand,
		deleteSkillCommand,
		toggleSkillEnabledCommand
	} from '$lib/skills';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';
	import { skillsPanel } from '$lib/state.svelte';

	type SkillRow = Awaited<ReturnType<typeof listSkillsQuery>>[number];

	let search = $state('');
	let busy = $state(false);
	let skills = $state<SkillRow[]>([]);
	let allSkills = $state<SkillRow[]>([]);

	/* ── Create modal ────────────────────── */
	let showCreate = $state(false);
	let newName = $state('');
	let newDescription = $state('');
	let newContent = $state('');
	let newTags = $state('');
	let createDialogEl = $state<HTMLDialogElement | undefined>(undefined);

	let filterTimer: ReturnType<typeof setTimeout> | undefined;

	onMount(() => {
		void loadSkills();
	});

	async function loadSkills() {
		allSkills = await listSkillsQuery({ limit: 200 });
		filterLocally();
	}

	function filterLocally() {
		const q = search.trim().toLowerCase();

		let filtered = allSkills;
		filtered = filtered.filter((s) => !s.name.startsWith('capability:'));

		// Filter by search text
		if (q) {
			filtered = filtered.filter(
				(s) =>
					s.name.toLowerCase().includes(q) ||
					s.description.toLowerCase().includes(q) ||
					s.tags.some((t) => t.toLowerCase().includes(q))
			);
		}

		skills = filtered;
	}

	function handleSearchInput() {
		clearTimeout(filterTimer);
		filterTimer = setTimeout(filterLocally, 150);
	}

	function openCreateModal() {
		newName = '';
		newDescription = '';
		newContent = '';
		newTags = '';
		showCreate = true;
		setTimeout(() => createDialogEl?.showModal(), 0);
	}

	async function handleCreate() {
		if (busy || !newName.trim() || !newDescription.trim() || !newContent.trim()) return;
		busy = true;
		try {
			const tags = newTags
				.split(',')
				.map((t) => t.trim())
				.filter(Boolean);
			await createSkillCommand({
				name: newName.trim(),
				description: newDescription.trim(),
				content: newContent.trim(),
				tags: tags.length > 0 ? tags : undefined
			});
			showCreate = false;
			createDialogEl?.close();
			await loadSkills();
		} finally {
			busy = false;
		}
	}

	async function handleToggleEnabled(skill: SkillRow) {
		await toggleSkillEnabledCommand({ id: skill.id, enabled: !skill.enabled });
		await loadSkills();
	}

	async function handleDelete(id: string) {
		if (!confirm('Delete this skill and all its files?')) return;
		await deleteSkillCommand({ id });
		await loadSkills();
	}
</script>

<div class="flex h-full min-h-0 flex-col space-y-3 sm:space-y-4">
	<ContentPanel>
		{#snippet header()}
			<div>
				<h1 class="text-xl font-bold sm:text-3xl">Skills</h1>
				<p class="text-xs text-base-content/70 sm:text-sm">
					{skills.length} {skills.length === 1 ? 'skill' : 'skills'} - Reusable instruction bundles for the LLM
				</p>
			</div>
		{/snippet}
		{#snippet actions()}
			<button class="btn btn-sm btn-primary sm:btn-md" onclick={openCreateModal}>+ New Skill</button>
			<button
				class="btn btn-sm btn-outline gap-1.5 sm:btn-md lg:hidden"
				type="button"
				onclick={() => (skillsPanel.open = true)}
			>
				Stats
				<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M9 5l7 7-7 7" /></svg>
			</button>
		{/snippet}
	</ContentPanel>

	<!-- Search -->
	<div class="flex shrink-0 items-center gap-2">
		<input
			class="input input-bordered input-md flex-1"
			bind:value={search}
			oninput={handleSearchInput}
			placeholder="Search skills..."
		/>
	</div>

	<!-- Skill list (scrollable) -->
	<div class="min-h-0 flex-1 overflow-y-auto rounded-xl bg-base-200/40 px-3 sm:px-4">
	{#if skills.length === 0}
		<div class="flex flex-col items-center gap-2 py-16 opacity-50">
			<svg xmlns="http://www.w3.org/2000/svg" class="size-12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
				<path d="M22 10v6M2 10l10-5 10 5-10 5z"/>
				<path d="M6 12v5c0 1.66 2.69 3 6 3s6-1.34 6-3v-5"/>
			</svg>
			<p class="text-sm">No skills yet. Create one to get started.</p>
		</div>
	{:else}
		<div class="space-y-2">
			{#each skills as skill (skill.id)}
				<div class="rounded-xl border border-base-300 bg-base-100 p-4 transition-colors hover:border-base-content/20">
					<div class="flex items-start justify-between gap-3">
						<a href="/skills/{skill.id}" class="min-w-0 flex-1">
							<div class="flex items-center gap-2">
								<h3 class="font-semibold">{skill.name}</h3>
								{#if !skill.enabled}
									<span class="badge badge-ghost badge-xs">disabled</span>
								{/if}
							</div>
							<p class="mt-0.5 text-sm opacity-60">{skill.description}</p>
							<div class="mt-2 flex flex-wrap items-center gap-2 text-xs opacity-50">
								{#if skill.tags.length > 0}
									{#each skill.tags as tag}
										<span class="badge badge-outline badge-xs">{tag}</span>
									{/each}
								{/if}
								<span>{skill.fileCount} file{skill.fileCount !== 1 ? 's' : ''}</span>
								<span>&middot;</span>
								<span>{skill.accessCount} reads</span>
							</div>
						</a>
						<div class="flex shrink-0 items-center gap-1">
							<input
								type="checkbox"
								class="toggle toggle-sm toggle-primary"
								checked={skill.enabled}
								onchange={() => handleToggleEnabled(skill)}
								title={skill.enabled ? 'Disable' : 'Enable'}
							/>
							<button
								class="btn btn-ghost btn-xs text-error"
								onclick={() => handleDelete(skill.id)}
								title="Delete"
							>
								<svg xmlns="http://www.w3.org/2000/svg" class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
								</svg>
							</button>
						</div>
					</div>
				</div>
			{/each}
		</div>
	{/if}
	</div>
</div>

<!-- Create skill dialog -->
{#if showCreate}
	<dialog bind:this={createDialogEl} class="modal" onclose={() => (showCreate = false)}>
		<div class="modal-box max-w-2xl">
			<h3 class="mb-4 text-lg font-bold">Create Skill</h3>
			<form onsubmit={(e) => { e.preventDefault(); handleCreate(); }} class="space-y-3">
				<div class="form-control">
					<label class="label" for="skill-name"><span class="label-text">Name</span></label>
					<input id="skill-name" type="text" class="input input-bordered input-sm" placeholder="e.g. sveltekit-dev" bind:value={newName} required />
				</div>
				<div class="form-control">
					<label class="label" for="skill-desc"><span class="label-text">Description</span></label>
					<input id="skill-desc" type="text" class="input input-bordered input-sm" placeholder="Short summary for LLM auto-detection" bind:value={newDescription} required />
				</div>
				<div class="form-control">
					<label class="label" for="skill-tags"><span class="label-text">Tags (comma-separated)</span></label>
					<input id="skill-tags" type="text" class="input input-bordered input-sm" placeholder="sveltekit, web, frontend" bind:value={newTags} />
				</div>
				<div class="form-control">
					<label class="label" for="skill-content"><span class="label-text">Content (Markdown)</span></label>
					<textarea id="skill-content" class="textarea textarea-bordered min-h-48 text-sm" placeholder="Main skill instructions/knowledge..." bind:value={newContent} required></textarea>
				</div>
				<div class="modal-action">
					<button type="button" class="btn btn-ghost btn-sm" onclick={() => { showCreate = false; createDialogEl?.close(); }}>Cancel</button>
					<button type="submit" class="btn btn-primary btn-sm" disabled={busy || !newName.trim() || !newDescription.trim() || !newContent.trim()}>
						{busy ? 'Creating...' : 'Create'}
					</button>
				</div>
			</form>
		</div>
		<form method="dialog" class="modal-backdrop"><button>close</button></form>
	</dialog>
{/if}

