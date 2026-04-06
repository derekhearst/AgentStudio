<svelte:head><title>{skill?.name ?? 'Skill'} | DrokBot</title></svelte:head>

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
		toggleSkillEnabledCommand
	} from '$lib/skills';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';

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
		if (!skill) return;
		editingField = field;
		editValue = field === 'tags' ? skill.tags.join(', ') : skill[field];
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
		if (!skill) return;
		await toggleSkillEnabledCommand({ id: skill.id, enabled: !skill.enabled });
		await refresh();
	}

	async function handleDelete() {
		if (!skill || !confirm('Delete this skill and all its files?')) return;
		await deleteSkillCommand({ id: skill.id });
		goto('/skills');
	}

	/* ── File actions ────────────────────── */
	function openAddFileModal() {
		newFileName = '';
		newFileDesc = '';
		newFileContent = '';
		showAddFile = true;
		setTimeout(() => addFileDialogEl?.showModal(), 0);
	}

	async function handleAddFile() {
		if (!skill || busy || !newFileName.trim() || !newFileContent.trim()) return;
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
					</div>
				</div>
			{/snippet}

			<!-- Tags -->
			<div class="mb-4">
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

			<!-- Stats -->
			<div class="mb-4 flex gap-4 text-xs opacity-50">
				<span>{s.accessCount} reads</span>
				{#if s.lastAccessed}
					<span>Last: {new Date(s.lastAccessed).toLocaleDateString()}</span>
				{/if}
				<span>Created: {new Date(s.createdAt).toLocaleDateString()}</span>
			</div>

			<!-- Main content -->
			<div>
				<div class="mb-1 flex items-center justify-between">
					<span class="text-xs font-semibold uppercase tracking-wider opacity-40">Content</span>
					{#if editingField !== 'content'}
						<button class="btn btn-ghost btn-xs" onclick={() => startEdit('content')}>Edit</button>
					{/if}
				</div>
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

		<!-- Files section -->
		<ContentPanel>
			{#snippet header()}
				<div class="flex items-center justify-between">
					<h2 class="text-lg font-semibold">Files ({s.files.length})</h2>
					<button class="btn btn-primary btn-xs" onclick={openAddFileModal}>+ Add File</button>
				</div>
			{/snippet}

			{#if s.files.length === 0}
				<p class="py-6 text-center text-sm opacity-50">No nested files. Add one for additional context.</p>
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
										<button class="btn btn-ghost btn-xs" onclick={() => startEditFile(file)} title="Edit">
											<svg xmlns="http://www.w3.org/2000/svg" class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
										</button>
										<button class="btn btn-ghost btn-xs text-error" onclick={() => handleDeleteFile(file.id)} title="Delete">
											<svg xmlns="http://www.w3.org/2000/svg" class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
										</button>
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
				<div class="form-control">
					<label class="label" for="file-name"><span class="label-text">File Name</span></label>
					<input id="file-name" type="text" class="input input-bordered input-sm" placeholder="e.g. forms.md" bind:value={newFileName} required />
				</div>
				<div class="form-control">
					<label class="label" for="file-desc"><span class="label-text">Description</span></label>
					<input id="file-desc" type="text" class="input input-bordered input-sm" placeholder="Short summary of this file's content" bind:value={newFileDesc} />
				</div>
				<div class="form-control">
					<label class="label" for="file-content"><span class="label-text">Content (Markdown)</span></label>
					<textarea id="file-content" class="textarea textarea-bordered min-h-48 text-sm" placeholder="File content..." bind:value={newFileContent} required></textarea>
				</div>
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

