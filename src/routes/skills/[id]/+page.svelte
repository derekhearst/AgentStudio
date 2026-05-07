<svelte:head><title>{skill?.name ?? 'Skill'} | AgentStudio</title></svelte:head>

<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import {
		getSkillByIdQuery,
		getCapabilityGroupsQuery,
		updateSkillCommand,
		deleteSkillCommand,
		addSkillFileCommand,
		updateSkillFileCommand,
		deleteSkillFileCommand,
		toggleSkillEnabledCommand,
		exportSkillCommand
	} from '$lib/skills';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';

	const skillId = $derived(page.params.id ?? '');

	type SkillDetail = NonNullable<Awaited<ReturnType<typeof getSkillByIdQuery>>>;
	type SkillFile = SkillDetail['files'][number];
	type CapabilityGroup = Awaited<ReturnType<typeof getCapabilityGroupsQuery>>[number];

	let skill = $state<SkillDetail | null>(null);
	let loading = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);

	/* ── Editing state ───────────────────── */
	let editingField = $state<'name' | 'description' | 'content' | 'tags' | 'companionTools' | null>(null);
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

	/* ── Companion mapping editor — chips dynamic from capabilityGroups registry ── */
	let allGroups = $state<CapabilityGroup[]>([]);
	let editingCompanionGroups = $state(false);
	let draftCompanionGroups = $state<string[]>([]);

	function startEditCompanionGroups() {
		if (!skill || skill.isSystem) return;
		draftCompanionGroups = Array.isArray(skill.companionGroups) ? [...skill.companionGroups] : [];
		editingCompanionGroups = true;
	}

	function toggleCompanionGroup(g: string) {
		if (draftCompanionGroups.includes(g)) {
			draftCompanionGroups = draftCompanionGroups.filter((x) => x !== g);
		} else {
			draftCompanionGroups = [...draftCompanionGroups, g];
		}
	}

	async function saveCompanionGroups() {
		if (!skill) return;
		busy = true;
		try {
			await updateSkillCommand({ id: skill.id, companionGroups: draftCompanionGroups });
			editingCompanionGroups = false;
			await refresh();
		} finally {
			busy = false;
		}
	}

	function cancelCompanionGroupsEdit() {
		editingCompanionGroups = false;
	}

	/* ── File editing state ──────────────── */
	let editingFileId = $state<string | null>(null);
	let editFileName = $state('');
	let editFileDesc = $state('');
	let editFileContent = $state('');
	let expandedFileId = $state<string | null>(null);

	/* ── Add file modal ──────────────────── */
	let showAddFile = $state(false);
	let newFileName = $state('');
	let newFileDesc = $state('');
	let newFileContent = $state('');
	let addFileDialogEl = $state<HTMLDialogElement | undefined>(undefined);
	const isSystemSkill = $derived(Boolean(skill?.isSystem));

	/* ── SKILL.md export modal ───────────── */
	let showExport = $state(false);
	let exportSkillMd = $state('');
	let exportResources = $state<Array<{ name: string; description?: string; content: string }>>([]);
	let exportDialogEl = $state<HTMLDialogElement | undefined>(undefined);
	let exportCopied = $state(false);

	async function openExportModal() {
		if (!skill) return;
		busy = true;
		try {
			const out = await exportSkillCommand({ id: skill.id });
			exportSkillMd = out.skillMd;
			exportResources = out.resources;
			showExport = true;
			exportCopied = false;
			setTimeout(() => exportDialogEl?.showModal(), 0);
		} finally {
			busy = false;
		}
	}

	async function copyExportText() {
		const text = exportResources.length === 0
			? exportSkillMd
			: [
				exportSkillMd,
				'',
				'---',
				'',
				...exportResources.map((r) => `## resources/${r.name}\n\n${r.content}`),
			].join('\n');
		try {
			await navigator.clipboard.writeText(text);
			exportCopied = true;
			setTimeout(() => (exportCopied = false), 2000);
		} catch {
			// Clipboard API can fail in non-secure contexts; user can still select + copy manually.
		}
	}

	function closeExportModal() {
		showExport = false;
		exportDialogEl?.close();
	}

	onMount(() => {
		void refresh();
		void loadGroups();
	});

	async function loadGroups() {
		allGroups = await getCapabilityGroupsQuery();
	}

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
	function startEdit(field: 'name' | 'description' | 'content' | 'tags' | 'companionTools') {
		if (!skill || skill.isSystem) return;
		editingField = field;
		if (field === 'tags') {
			editValue = skill.tags.join(', ');
		} else if (field === 'companionTools') {
			editValue = (skill.companionTools ?? []).join(', ');
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
			} else if (editingField === 'companionTools') {
				const companionTools = editValue.split(',').map((t) => t.trim()).filter(Boolean);
				await updateSkillCommand({ id: skill.id, companionTools });
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
		newFileName = '';
		newFileDesc = '';
		newFileContent = '';
		showAddFile = true;
		setTimeout(() => addFileDialogEl?.showModal(), 0);
	}

	async function handleAddFile() {
		if (!skill || skill.isSystem || busy || !newFileName.trim() || !newFileContent.trim()) return;
		busy = true;
		try {
			await addSkillFileCommand({
				skillId: skill.id,
				name: newFileName.trim(),
				description: newFileDesc.trim(),
				content: newFileContent.trim()
			});
			showAddFile = false;
			addFileDialogEl?.close();
			await refresh();
		} finally {
			busy = false;
		}
	}

	function startEditFile(file: SkillFile) {
		if (skill?.isSystem) return;
		editingFileId = file.id;
		editFileName = file.name;
		editFileDesc = file.description;
		editFileContent = file.content;
	}

	async function saveFileEdit() {
		if (!editingFileId || busy) return;
		busy = true;
		try {
			await updateSkillFileCommand({
				fileId: editingFileId,
				name: editFileName.trim() || undefined,
				description: editFileDesc.trim(),
				content: editFileContent.trim() || undefined
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

<div class="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
	<!-- Back link -->
	<a href="/skills" class="btn btn-ghost btn-xs gap-1">
		<svg xmlns="http://www.w3.org/2000/svg" class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 18-6-6 6-6"/></svg>
		All Skills
	</a>

	{#if loading}
		<div class="flex justify-center py-16"><span class="loading loading-spinner loading-lg"></span></div>
	{:else if error}
		<div class="alert alert-error">{error}</div>
	{:else if skill}
		{@const s = skill}
		{#if isSystemSkill}
			<div class="alert alert-info">
				This is a built-in DrokBot guide skill. It is read-only and always available.
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

			<!-- Companion mapping — auto-load this skill's summary when its group enables -->
			<div class="mb-4 space-y-3">
				<div>
					<div class="mb-1 flex items-center justify-between">
						<div class="text-xs font-semibold uppercase tracking-wider opacity-40">Companion to capability groups</div>
						{#if !isSystemSkill && !editingCompanionGroups}
							<button class="btn btn-ghost btn-xs" onclick={startEditCompanionGroups}>Edit</button>
						{/if}
					</div>
					<p class="mb-2 text-[11px] leading-snug opacity-55">
						When the agent enables one of these groups (auto-suggest or <code class="font-mono">enable_capability</code>), this skill's summary is auto-injected into the system prompt so the model knows when and how to use the new tools.
					</p>
					{#if editingCompanionGroups}
						<div class="flex flex-wrap gap-2">
							{#each allGroups as group (group.name)}
								{@const checked = draftCompanionGroups.includes(group.name)}
								<label class="flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-1.5 text-xs transition-colors {checked ? 'border-info/55 bg-info/10' : 'border-base-300/60 bg-base-200/30 hover:bg-base-200/55'}" title={group.description}>
									<input type="checkbox" class="checkbox checkbox-xs" {checked} onchange={() => toggleCompanionGroup(group.name)} />
									<span class="font-mono">{group.name}</span>
								</label>
							{/each}
						</div>
						<div class="mt-2 flex gap-2">
							<button class="btn btn-primary btn-xs" onclick={saveCompanionGroups} disabled={busy}>Save</button>
							<button class="btn btn-ghost btn-xs" onclick={cancelCompanionGroupsEdit}>Cancel</button>
						</div>
					{:else if Array.isArray(s.companionGroups) && s.companionGroups.length > 0}
						<div class="flex flex-wrap gap-1.5">
							{#each s.companionGroups as group (group)}
								<span class="badge badge-info badge-sm font-mono">{group}</span>
							{/each}
						</div>
					{:else}
						<span class="text-xs opacity-40">No groups{isSystemSkill ? '' : ' — click Edit to assign'}</span>
					{/if}
				</div>

				<div>
					<div class="mb-1 flex items-center justify-between">
						<div class="text-xs font-semibold uppercase tracking-wider opacity-40">Companion to specific tools</div>
						{#if !isSystemSkill && editingField !== 'companionTools'}
							<button class="btn btn-ghost btn-xs" onclick={() => startEdit('companionTools')}>Edit</button>
						{/if}
					</div>
					{#if editingField === 'companionTools'}
						<div class="flex items-center gap-2">
							<input type="text" class="input input-bordered input-sm flex-1" placeholder="comma-separated tool names (e.g. shell, file_patch)" bind:value={editValue} />
							<button class="btn btn-primary btn-xs" onclick={saveEdit} disabled={busy}>Save</button>
							<button class="btn btn-ghost btn-xs" onclick={cancelEdit}>Cancel</button>
						</div>
					{:else if Array.isArray(s.companionTools) && s.companionTools.length > 0}
						<div class="flex flex-wrap gap-1.5">
							{#each s.companionTools as tool (tool)}
								<span class="badge badge-outline badge-sm font-mono">{tool}</span>
							{/each}
						</div>
					{:else}
						<span class="text-xs opacity-40">No tools{isSystemSkill ? '' : ' — click Edit to assign'}</span>
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
						{#if editingFileId === file.id}
							<!-- Inline file editor -->
							<div class="rounded-lg border border-primary/30 bg-base-200 p-3 space-y-2">
								<div class="flex gap-2">
									<input type="text" class="input input-bordered input-sm flex-1" placeholder="File name" bind:value={editFileName} />
									<input type="text" class="input input-bordered input-sm flex-1" placeholder="Description" bind:value={editFileDesc} />
								</div>
								<textarea class="textarea textarea-bordered min-h-40 w-full text-sm font-mono" bind:value={editFileContent}></textarea>
								<div class="flex gap-2">
									<button class="btn btn-primary btn-xs" onclick={saveFileEdit} disabled={busy}>Save</button>
									<button class="btn btn-ghost btn-xs" onclick={cancelFileEdit}>Cancel</button>
								</div>
							</div>
						{:else}
							<div class="rounded-lg border border-base-300 bg-base-100 p-3">
								<div class="flex items-center justify-between gap-2">
									<button class="min-w-0 flex-1 text-left" onclick={() => toggleExpand(file.id)}>
										<div class="flex items-center gap-2">
											<svg xmlns="http://www.w3.org/2000/svg" class="size-3 shrink-0 transition-transform opacity-40" class:rotate-90={expandedFileId === file.id} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>
											<span class="font-mono text-sm font-medium">{file.name}</span>
											{#if file.description}
												<span class="text-xs opacity-50">{file.description}</span>
											{/if}
										</div>
									</button>
									<div class="flex shrink-0 gap-1">
										{#if !isSystemSkill}
											<button class="btn btn-ghost btn-xs" onclick={() => startEditFile(file)} title="Edit">
												<svg xmlns="http://www.w3.org/2000/svg" class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
											</button>
											<button class="btn btn-ghost btn-xs text-error" onclick={() => handleDeleteFile(file.id)} title="Delete">
												<svg xmlns="http://www.w3.org/2000/svg" class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
											</button>
										{/if}
									</div>
								</div>
								{#if expandedFileId === file.id}
									<pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-base-200 p-3 text-sm">{file.content}</pre>
								{/if}
							</div>
						{/if}
					{/each}
				</div>
			{/if}
		</ContentPanel>
	{/if}
</div>

<!-- Add file dialog -->
{#if showAddFile}
	<dialog bind:this={addFileDialogEl} class="modal" onclose={() => (showAddFile = false)}>
		<div class="modal-box max-w-2xl">
			<h3 class="mb-4 text-lg font-bold">Add File</h3>
			<form onsubmit={(e) => { e.preventDefault(); handleAddFile(); }} class="space-y-3">
				<fieldset class="fieldset">
					<legend class="fieldset-legend"><label for="file-name">File Name</label></legend>
					<input id="file-name" type="text" class="input input-bordered input-sm" placeholder="e.g. forms.md" bind:value={newFileName} required />
				</fieldset>
				<fieldset class="fieldset">
					<legend class="fieldset-legend"><label for="file-desc">Description</label></legend>
					<input id="file-desc" type="text" class="input input-bordered input-sm" placeholder="Short summary of this file's content" bind:value={newFileDesc} />
				</fieldset>
				<fieldset class="fieldset">
					<legend class="fieldset-legend"><label for="file-content">Content (Markdown)</label></legend>
					<textarea id="file-content" class="textarea textarea-bordered min-h-48 text-sm" placeholder="File content..." bind:value={newFileContent} required></textarea>
				</fieldset>
				<div class="modal-action">
					<button type="button" class="btn btn-ghost btn-sm" onclick={() => { showAddFile = false; addFileDialogEl?.close(); }}>Cancel</button>
					<button type="submit" class="btn btn-primary btn-sm" disabled={busy || !newFileName.trim() || !newFileContent.trim()}>
						{busy ? 'Adding...' : 'Add File'}
					</button>
				</div>
			</form>
		</div>
		<form method="dialog" class="modal-backdrop"><button>close</button></form>
	</dialog>
{/if}

<!-- SKILL.md export dialog -->
{#if showExport}
	<dialog bind:this={exportDialogEl} class="modal" onclose={() => (showExport = false)}>
		<div class="modal-box max-w-3xl">
			<div class="mb-3 flex items-center justify-between gap-3">
				<div>
					<h3 class="text-lg font-bold">Export as SKILL.md package</h3>
					<p class="mt-0.5 text-xs opacity-60">Round-trip-clean — paste into the Import dialog on /skills to recreate this skill.</p>
				</div>
				<button class="btn btn-ghost btn-xs" onclick={copyExportText}>
					{exportCopied ? 'Copied!' : 'Copy all'}
				</button>
			</div>
			<div class="space-y-3">
				<div>
					<div class="mb-1 text-xs font-semibold uppercase tracking-wider opacity-40">SKILL.md</div>
					<pre class="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-base-200 p-3 font-mono text-xs">{exportSkillMd}</pre>
				</div>
				{#if exportResources.length > 0}
					<div>
						<div class="mb-1 text-xs font-semibold uppercase tracking-wider opacity-40">Resource files ({exportResources.length})</div>
						<div class="space-y-2">
							{#each exportResources as r (r.name)}
								<details class="rounded-lg bg-base-200 p-2">
									<summary class="cursor-pointer font-mono text-xs">resources/{r.name}</summary>
									<pre class="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-base-100 p-2 text-xs">{r.content}</pre>
								</details>
							{/each}
						</div>
					</div>
				{/if}
			</div>
			<div class="modal-action">
				<button type="button" class="btn btn-ghost btn-sm" onclick={closeExportModal}>Close</button>
			</div>
		</div>
		<form method="dialog" class="modal-backdrop"><button>close</button></form>
	</dialog>
{/if}

