<script lang="ts">
	import type { getSkillByIdQuery } from '$lib/skills'

	type SkillDetail = NonNullable<Awaited<ReturnType<typeof getSkillByIdQuery>>>
	type SkillFile = SkillDetail['files'][number]

	let {
		file,
		expanded = false,
		editing = false,
		isSystemSkill = false,
		busy = false,
		onToggleExpand,
		onStartEdit,
		onSaveEdit,
		onCancelEdit,
		onDelete,
	} = $props<{
		file: SkillFile
		expanded?: boolean
		editing?: boolean
		isSystemSkill?: boolean
		busy?: boolean
		onToggleExpand: (fileId: string) => void
		onStartEdit: (file: SkillFile) => void
		onSaveEdit: (fields: { name: string; description: string; content: string }) => void | Promise<void>
		onCancelEdit: () => void
		onDelete: (fileId: string) => void
	}>()

	let editName = $state('')
	let editDesc = $state('')
	let editContent = $state('')

	$effect(() => {
		if (editing) {
			editName = file.name
			editDesc = file.description
			editContent = file.content
		}
	})

	async function handleSave() {
		await onSaveEdit({
			name: editName.trim(),
			description: editDesc.trim(),
			content: editContent.trim(),
		})
	}
</script>

{#if editing}
	<div class="rounded-lg border border-primary/30 bg-base-200 p-3 space-y-2">
		<div class="flex gap-2">
			<input type="text" class="input input-bordered input-sm flex-1" placeholder="File name" bind:value={editName} />
			<input type="text" class="input input-bordered input-sm flex-1" placeholder="Description" bind:value={editDesc} />
		</div>
		<textarea class="textarea textarea-bordered min-h-40 w-full text-sm font-mono" bind:value={editContent}></textarea>
		<div class="flex gap-2">
			<button class="btn btn-primary btn-xs" onclick={handleSave} disabled={busy}>Save</button>
			<button class="btn btn-ghost btn-xs" onclick={onCancelEdit}>Cancel</button>
		</div>
	</div>
{:else}
	<div class="rounded-lg border border-base-300 bg-base-100 p-3">
		<div class="flex items-center justify-between gap-2">
			<button class="min-w-0 flex-1 text-left" onclick={() => onToggleExpand(file.id)}>
				<div class="flex items-center gap-2">
					<svg
						xmlns="http://www.w3.org/2000/svg"
						class="size-3 shrink-0 transition-transform opacity-40"
						class:rotate-90={expanded}
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
					><path d="m9 18 6-6-6-6"/></svg>
					<span class="font-mono text-sm font-medium">{file.name}</span>
					{#if file.description}
						<span class="text-xs opacity-50">{file.description}</span>
					{/if}
				</div>
			</button>
			<div class="flex shrink-0 gap-1">
				{#if !isSystemSkill}
					<button class="btn btn-ghost btn-xs" onclick={() => onStartEdit(file)} title="Edit">
						<svg xmlns="http://www.w3.org/2000/svg" class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
					</button>
					<button class="btn btn-ghost btn-xs text-error" onclick={() => onDelete(file.id)} title="Delete">
						<svg xmlns="http://www.w3.org/2000/svg" class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
					</button>
				{/if}
			</div>
		</div>
		{#if expanded}
			<pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-base-200 p-3 text-sm">{file.content}</pre>
		{/if}
	</div>
{/if}
