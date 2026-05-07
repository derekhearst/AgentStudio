<svelte:head><title>Skills | AgentStudio</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { listSkillsQuery, importSkillCommand } from '$lib/skills';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';

	type SkillRow = Awaited<ReturnType<typeof listSkillsQuery>>[number];

	let search = $state('');
	let skills = $state<SkillRow[]>([]);
	let allSkills = $state<SkillRow[]>([]);

	let filterTimer: ReturnType<typeof setTimeout> | undefined;

	/* ── Import SKILL.md modal ───────────── */
	let showImport = $state(false);
	let importSource = $state('');
	let importMode = $state<'create' | 'overwrite'>('create');
	let importBusy = $state(false);
	let importError = $state<string | null>(null);
	let importDialogEl = $state<HTMLDialogElement | undefined>(undefined);

	function openImportModal() {
		importSource = '';
		importMode = 'create';
		importError = null;
		showImport = true;
		setTimeout(() => importDialogEl?.showModal(), 0);
	}

	function closeImportModal() {
		showImport = false;
		importDialogEl?.close();
	}

	async function handleImport() {
		if (!importSource.trim() || importBusy) return;
		importBusy = true;
		importError = null;
		try {
			const result = await importSkillCommand({ source: importSource.trim(), mode: importMode });
			closeImportModal();
			await loadSkills();
			void goto(`/skills/${result.id}`);
		} catch (e) {
			importError = e instanceof Error ? e.message : 'Import failed';
		} finally {
			importBusy = false;
		}
	}

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

</script>

<div class="flex h-full min-h-0 flex-col space-y-3 sm:space-y-4">
	<ContentPanel>
		{#snippet header()}
			<div class="flex items-center justify-between gap-3">
				<div>
					<h1 class="text-xl font-bold sm:text-3xl">Skills</h1>
					<p class="text-xs text-base-content/70 sm:text-sm">
						{skills.length} {skills.length === 1 ? 'skill' : 'skills'} — Reusable instruction packages. Summaries auto-load; full bodies and resource files load on demand.
					</p>
				</div>
				<button class="btn btn-ghost btn-sm gap-1" onclick={openImportModal} title="Import a SKILL.md package">
					<svg xmlns="http://www.w3.org/2000/svg" class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v14m0 0 4-4m-4 4-4-4M5 21h14"/></svg>
					Import
				</button>
			</div>
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
			<p class="text-sm">No skills yet. Start a guided creation chat to create one.</p>
		</div>
	{:else}
		<div class="space-y-2">
			{#each skills as skill (skill.id)}
				<a href="/skills/{skill.id}" class="block rounded-xl border border-base-300 bg-base-100 p-4 transition-colors hover:border-base-content/20">
					<div class="flex items-center gap-2">
						<h3 class="font-semibold">{skill.name}</h3>
						{#if skill.category}
							<span class="badge badge-neutral badge-xs">{skill.category}</span>
						{/if}
						{#if skill.isSystem}
							<span class="badge badge-primary badge-xs">built-in</span>
						{/if}
						{#if !skill.enabled}
							<span class="badge badge-ghost badge-xs">disabled</span>
						{/if}
					</div>
					<p class="mt-0.5 text-sm opacity-60">{skill.description}</p>
					<div class="mt-2 flex flex-wrap items-center gap-2 text-xs opacity-50">
						{#if skill.tags.length > 0}
							{#each skill.tags as tag (tag)}
								<span class="badge badge-outline badge-xs">{tag}</span>
							{/each}
						{/if}
						<span>{skill.fileCount} file{skill.fileCount !== 1 ? 's' : ''}</span>
						<span>&middot;</span>
						<span>{skill.accessCount} reads</span>
					</div>
				</a>
			{/each}
		</div>
	{/if}
	</div>
</div>

<!-- Import SKILL.md dialog -->
{#if showImport}
	<dialog bind:this={importDialogEl} class="modal" onclose={() => (showImport = false)}>
		<div class="modal-box max-w-3xl">
			<h3 class="mb-3 text-lg font-bold">Import SKILL.md package</h3>
			<p class="mb-3 text-xs leading-snug opacity-60">
				Paste a SKILL.md document (frontmatter + body). Supported frontmatter keys:
				<code class="font-mono">name</code>, <code class="font-mono">description</code> (required),
				<code class="font-mono">category</code>, <code class="font-mono">tags</code>,
				<code class="font-mono">companion_groups</code>, <code class="font-mono">companion_tools</code>,
				<code class="font-mono">enabled</code>.
			</p>
			<textarea
				class="textarea textarea-bordered min-h-72 w-full font-mono text-xs"
				placeholder={"---\nname: tools/my-skill\ndescription: Short summary of what this skill teaches.\ntags: [example]\ncompanion_groups: [sandbox]\n---\n\n# Body of the skill\n\nInstructions go here…"}
				bind:value={importSource}
			></textarea>
			<div class="mt-3 flex items-center gap-3 text-xs">
				<span class="opacity-60">If a skill with the same name already exists:</span>
				<label class="flex cursor-pointer items-center gap-1">
					<input type="radio" class="radio radio-xs" name="import-mode" value="create" checked={importMode === 'create'} onchange={() => (importMode = 'create')} />
					<span>Fail (create only)</span>
				</label>
				<label class="flex cursor-pointer items-center gap-1">
					<input type="radio" class="radio radio-xs" name="import-mode" value="overwrite" checked={importMode === 'overwrite'} onchange={() => (importMode = 'overwrite')} />
					<span>Overwrite</span>
				</label>
			</div>
			{#if importError}
				<div class="alert alert-error mt-3 text-sm">{importError}</div>
			{/if}
			<div class="modal-action">
				<button type="button" class="btn btn-ghost btn-sm" onclick={closeImportModal}>Cancel</button>
				<button type="button" class="btn btn-primary btn-sm" onclick={handleImport} disabled={importBusy || !importSource.trim()}>
					{importBusy ? 'Importing…' : 'Import'}
				</button>
			</div>
		</div>
		<form method="dialog" class="modal-backdrop"><button>close</button></form>
	</dialog>
{/if}
