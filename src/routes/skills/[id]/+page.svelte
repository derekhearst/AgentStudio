<svelte:head><title>{skill?.name ?? 'Skill'} | AgentStudio</title></svelte:head>

<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import {
		getSkillByIdQuery,
		updateSkillCommand,
		deleteSkillCommand,
		addSkillFileCommand,
		updateSkillFileCommand,
		deleteSkillFileCommand,
		toggleSkillEnabledCommand,
		exportSkillCommand
	} from '$lib/skills';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import AddSkillFileDialog from '$lib/skills/AddSkillFileDialog.svelte';
	import SkillExportDialog from '$lib/skills/SkillExportDialog.svelte';
	import SkillFileItem from '$lib/skills/SkillFileItem.svelte';

	const skillId = $derived(page.params.id ?? '');

	type SkillDetail = NonNullable<Awaited<ReturnType<typeof getSkillByIdQuery>>>;
	type SkillFile = SkillDetail['files'][number];

	let skill = $state<SkillDetail | null>(null);
	let loading = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);

	/* ── Editing state ───────────────────── */
	let editingField = $state<'name' | 'description' | 'content' | 'tags' | null>(null);
	let editValue = $state('');

	const CATEGORIES = ['tool', 'workflow', 'domain', 'policy', 'identity', 'hook'] as const;
	type Category = (typeof CATEGORIES)[number];

	async function changeCategory(next: string) {
		if (!skill || skill.isSystem) return;
		busy = true;
		try {
			const value = next === '' ? null : (next as Category);
			await updateSkillCommand({ id: skill.id, category: value });
			await refresh();
		} finally {
			busy = false;
		}
	}

	/* ── File editing state ──────────────── */
	let editingFileId = $state<string | null>(null);
	let expandedFileId = $state<string | null>(null);

	/* ── Add file modal ──────────────────── */
	let showAddFile = $state(false);
	const isSystemSkill = $derived(Boolean(skill?.isSystem));

	/* ── SKILL.md export modal ───────────── */
	let showExport = $state(false);
	let exportSkillMd = $state('');
	let exportResources = $state<Array<{ name: string; description?: string; content: string }>>([]);

	async function openExportModal() {
		if (!skill) return;
		busy = true;
		try {
			const out = await exportSkillCommand({ id: skill.id });
			exportSkillMd = out.skillMd;
			exportResources = out.resources;
			showExport = true;
		} finally {
			busy = false;
		}
	}

	onMount(() => {
		void refresh();
	});

	async function refresh() {
		loading = true;
		error = null;
		try {
			skill = await getSkillByIdQuery({ id: skillId });
			if (!skill) error = 'Skill not found';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load';
		} finally {
			loading = false;
		}
	}

	/* ── Inline editing ──────────────────── */
	function startEdit(field: 'name' | 'description' | 'content' | 'tags') {
		if (!skill || skill.isSystem) return;
		editingField = field;
		if (field === 'tags') {
			editValue = skill.tags.join(', ');
		} else {
			editValue = skill[field];
		}
	}

	async function saveEdit() {
		if (!skill || !editingField) return;
		busy = true;
		try {
			if (editingField === 'tags') {
				const tags = editValue.split(',').map((t) => t.trim()).filter(Boolean);
				await updateSkillCommand({ id: skill.id, tags });
			} else {
				await updateSkillCommand({ id: skill.id, [editingField]: editValue.trim() });
			}
			editingField = null;
			await refresh();
		} finally {
			busy = false;
		}
	}

	function cancelEdit() {
		editingField = null;
	}

	/* ── Skill actions ───────────────────── */
	async function handleToggleEnabled() {
		if (!skill || skill.isSystem) return;
		await toggleSkillEnabledCommand({ id: skill.id, enabled: !skill.enabled });
		await refresh();
	}

	async function handleDelete() {
		if (!skill || skill.isSystem || !confirm('Delete this skill and all its files?')) return;
		await deleteSkillCommand({ id: skill.id });
		goto('/skills');
	}

	/* ── File actions ────────────────────── */
	function openAddFileModal() {
		if (skill?.isSystem) return;
		showAddFile = true;
	}

	async function handleAddFile(input: { name: string; description: string; content: string }) {
		if (!skill || skill.isSystem || busy) return;
		busy = true;
		try {
			await addSkillFileCommand({
				skillId: skill.id,
				name: input.name,
				description: input.description,
				content: input.content,
			});
			showAddFile = false;
			await refresh();
		} finally {
			busy = false;
		}
	}

	function startEditFile(file: SkillFile) {
		if (skill?.isSystem) return;
		editingFileId = file.id;
	}

	async function saveFileEdit(fields: { name: string; description: string; content: string }) {
		if (!editingFileId || busy) return;
		busy = true;
		try {
			await updateSkillFileCommand({
				fileId: editingFileId,
				name: fields.name || undefined,
				description: fields.description,
				content: fields.content || undefined,
			});
			editingFileId = null;
			await refresh();
		} finally {
			busy = false;
		}
	}

	function cancelFileEdit() {
		editingFileId = null;
	}

	async function handleDeleteFile(fileId: string) {
		if (skill?.isSystem) return;
		if (!confirm('Delete this file?')) return;
		await deleteSkillFileCommand({ fileId });
		await refresh();
	}

	function toggleExpand(fileId: string) {
		expandedFileId = expandedFileId === fileId ? null : fileId;
	}
</script>

<div class="flex h-full min-h-0 flex-col">
	<PageHeader
		title={skill?.name ?? 'Skill'}
		crumbs={[{ label: 'Skills', href: '/skills' }]}
		backHref="/skills"
		subtitle={skill?.description}
	>
		{#snippet chips()}
			{#if skill}
				{#if isSystemSkill}
					<span class="console-chip">built-in</span>
				{/if}
				{#if !skill.enabled}
					<span class="console-chip">disabled</span>
				{/if}
			{/if}
		{/snippet}
		{#snippet actions()}
			{#if skill}
				<button class="btn btn-ghost btn-xs gap-1" onclick={openExportModal} title="Export as SKILL.md package" disabled={busy}>
					<svg xmlns="http://www.w3.org/2000/svg" class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 17V3m0 14-4-4m4 4 4-4M5 21h14"/></svg>
					Export
				</button>
			{/if}
		{/snippet}
	</PageHeader>

	<div class="min-h-0 flex-1 overflow-y-auto px-3 py-3 tablet:px-4 desktop:px-4 desktop:py-4">
		<div class="mx-auto max-w-4xl space-y-4">
			{#if loading}
				<div class="flex justify-center py-16"><span class="loading loading-spinner loading-lg"></span></div>
			{:else if error}
				<div class="alert alert-error">{error}</div>
			{:else if skill}
				{@const s = skill}
				{#if isSystemSkill}
					<div class="alert alert-info">
						This is a built-in AgentStudio guide skill. It is read-only and always available.
					</div>
				{/if}
				<!-- Skill header -->
				<ContentPanel>
					{#snippet header()}
						<div class="flex items-center justify-between gap-3">
							<div class="min-w-0 flex-1">
								{#if editingField === 'name'}
									<div class="flex items-center gap-2">
										<input type="text" class="input input-bordered input-sm flex-1" bind:value={editValue} />
										<button class="btn btn-primary btn-xs" onclick={saveEdit} disabled={busy}>Save</button>
										<button class="btn btn-ghost btn-xs" onclick={cancelEdit}>Cancel</button>
									</div>
								{:else}
									<h1 class="text-2xl font-bold">
										<button class="hover:text-primary" onclick={() => startEdit('name')} title="Edit name">{s.name}</button>
										{#if isSystemSkill}
											<span class="badge badge-primary badge-sm align-middle">built-in</span>
										{/if}
									</h1>
								{/if}

								{#if editingField === 'description'}
									<div class="mt-1 flex items-center gap-2">
										<input type="text" class="input input-bordered input-sm flex-1" bind:value={editValue} />
										<button class="btn btn-primary btn-xs" onclick={saveEdit} disabled={busy}>Save</button>
										<button class="btn btn-ghost btn-xs" onclick={cancelEdit}>Cancel</button>
									</div>
								{:else}
									<p class="mt-1 text-sm opacity-60">
										<button class="text-left hover:text-primary" onclick={() => startEdit('description')} title="Edit description">{s.description}</button>
									</p>
								{/if}
							</div>
							<div class="flex shrink-0 items-center gap-2">
								<button class="btn btn-ghost btn-xs gap-1" onclick={openExportModal} title="Export as SKILL.md package" disabled={busy}>
									<svg xmlns="http://www.w3.org/2000/svg" class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 17V3m0 14-4-4m4 4 4-4M5 21h14"/></svg>
									Export
								</button>
								{#if !isSystemSkill}
									<input
										type="checkbox"
										class="toggle toggle-sm toggle-primary"
										checked={s.enabled}
										onchange={handleToggleEnabled}
										title={s.enabled ? 'Disable' : 'Enable'}
									/>
									<button class="btn btn-ghost btn-xs text-error" onclick={handleDelete} title="Delete skill">
										<svg xmlns="http://www.w3.org/2000/svg" class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
									</button>
								{:else}
									<span class="badge badge-outline">read-only</span>
								{/if}
							</div>
						</div>
					{/snippet}

					<!-- Tags + Category -->
					<div class="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
						<div>
							<div class="mb-1 text-xs font-semibold uppercase tracking-wider opacity-40">Tags</div>
							{#if editingField === 'tags'}
								<div class="flex items-center gap-2">
									<input type="text" class="input input-bordered input-sm flex-1" placeholder="comma-separated" bind:value={editValue} />
									<button class="btn btn-primary btn-xs" onclick={saveEdit} disabled={busy}>Save</button>
									<button class="btn btn-ghost btn-xs" onclick={cancelEdit}>Cancel</button>
								</div>
							{:else}
								<button class="flex flex-wrap gap-1 text-left hover:opacity-80" onclick={() => startEdit('tags')}>
									{#if s.tags.length > 0}
										{#each s.tags as tag}
											<span class="badge badge-outline badge-sm">{tag}</span>
										{/each}
									{:else}
										<span class="text-xs opacity-40">No tags — click to add</span>
									{/if}
								</button>
							{/if}
						</div>
						<div>
							<div class="mb-1 text-xs font-semibold uppercase tracking-wider opacity-40">Category</div>
							{#if isSystemSkill}
								<span class="badge badge-neutral badge-sm">{s.category ?? '—'}</span>
							{:else}
								<select
									class="select select-bordered select-sm"
									value={s.category ?? ''}
									onchange={(e) => changeCategory((e.currentTarget as HTMLSelectElement).value)}
									disabled={busy}
								>
									<option value="">— uncategorized —</option>
									{#each CATEGORIES as c (c)}
										<option value={c}>{c}</option>
									{/each}
								</select>
							{/if}
						</div>
					</div>

					<!-- Stats -->
					<div class="mb-4 flex gap-4 text-xs opacity-50">
						<span>{s.accessCount} reads</span>
						{#if s.lastAccessed}
							<span>Last: {new Date(s.lastAccessed).toLocaleDateString()}</span>
						{/if}
						<span>Created: {new Date(s.createdAt).toLocaleDateString()}</span>
					</div>

					<!-- Primary instructions (SKILL.md body) -->
					<div>
						<div class="mb-1 flex items-center justify-between">
							<span class="text-xs font-semibold uppercase tracking-wider opacity-40">Primary instructions <code class="ml-1 normal-case opacity-70">SKILL.md</code></span>
							{#if editingField !== 'content' && !isSystemSkill}
								<button class="btn btn-ghost btn-xs" onclick={() => startEdit('content')}>Edit</button>
							{/if}
						</div>
						<p class="mb-2 text-[11px] leading-snug opacity-55">
							Loaded in full when the agent calls <code class="font-mono">read_skill</code>. Keep this body focused — under ~8&nbsp;KB. For long expansions, examples, or sub-topics, attach resource files below.
						</p>
						{#if editingField === 'content'}
							<textarea class="textarea textarea-bordered min-h-64 w-full text-sm font-mono" bind:value={editValue}></textarea>
							<div class="mt-2 flex gap-2">
								<button class="btn btn-primary btn-sm" onclick={saveEdit} disabled={busy}>Save</button>
								<button class="btn btn-ghost btn-sm" onclick={cancelEdit}>Cancel</button>
							</div>
						{:else}
							<pre class="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-base-200 p-3 text-sm">{s.content}</pre>
						{/if}
					</div>
				</ContentPanel>

				<!-- Resource files (loaded on demand via read_skill_file) -->
				<ContentPanel>
					{#snippet header()}
						<div class="flex items-center justify-between gap-3">
							<div class="min-w-0">
								<h2 class="text-lg font-semibold">Resource files ({s.files.length})</h2>
								<p class="mt-0.5 text-[11px] leading-snug opacity-55">
									Loaded on demand via <code class="font-mono">read_skill_file({s.name}, &lt;file&gt;)</code>. Use for examples, sub-topics, or templates the model only needs sometimes.
								</p>
							</div>
							{#if !isSystemSkill}
								<button class="btn btn-primary btn-xs shrink-0" onclick={openAddFileModal}>+ Add File</button>
							{/if}
						</div>
					{/snippet}

					{#if s.files.length === 0}
						<p class="py-6 text-center text-sm opacity-50">No resource files. Attach examples or sub-topics that should only load when the model asks for them.</p>
					{:else}
						<div class="space-y-2">
							{#each s.files as file (file.id)}
								<SkillFileItem
									{file}
									expanded={expandedFileId === file.id}
									editing={editingFileId === file.id}
									{isSystemSkill}
									{busy}
									onToggleExpand={toggleExpand}
									onStartEdit={startEditFile}
									onSaveEdit={saveFileEdit}
									onCancelEdit={cancelFileEdit}
									onDelete={handleDeleteFile}
								/>
							{/each}
						</div>
					{/if}
				</ContentPanel>
			{/if}
		</div>
	</div>
</div>

<AddSkillFileDialog
	open={showAddFile}
	{busy}
	onSubmit={handleAddFile}
	onClose={() => (showAddFile = false)}
/>

<SkillExportDialog
	open={showExport}
	skillMd={exportSkillMd}
	resources={exportResources}
	onClose={() => (showExport = false)}
/>
