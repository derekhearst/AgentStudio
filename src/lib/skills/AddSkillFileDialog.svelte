<script lang="ts">
	let {
		open,
		busy = false,
		onSubmit,
		onClose,
	} = $props<{
		open: boolean
		busy?: boolean
		onSubmit: (file: { name: string; description: string; content: string }) => void | Promise<void>
		onClose: () => void
	}>()

	let dialogEl = $state<HTMLDialogElement | undefined>(undefined)
	let name = $state('')
	let description = $state('')
	let content = $state('')

	$effect(() => {
		if (open) {
			name = ''
			description = ''
			content = ''
			setTimeout(() => dialogEl?.showModal(), 0)
		}
	})

	async function handleSubmit(event: Event) {
		event.preventDefault()
		if (busy || !name.trim() || !content.trim()) return
		await onSubmit({ name: name.trim(), description: description.trim(), content: content.trim() })
	}

	function handleCancel() {
		dialogEl?.close()
		onClose()
	}
</script>

{#if open}
	<dialog bind:this={dialogEl} class="modal" onclose={onClose}>
		<div class="modal-box max-w-2xl">
			<h3 class="mb-4 text-lg font-bold">Add File</h3>
			<form onsubmit={handleSubmit} class="space-y-3">
				<fieldset class="fieldset">
					<legend class="fieldset-legend"><label for="add-file-name">File Name</label></legend>
					<input id="add-file-name" type="text" class="input input-bordered input-sm" placeholder="e.g. forms.md" bind:value={name} required />
				</fieldset>
				<fieldset class="fieldset">
					<legend class="fieldset-legend"><label for="add-file-desc">Description</label></legend>
					<input id="add-file-desc" type="text" class="input input-bordered input-sm" placeholder="Short summary of this file's content" bind:value={description} />
				</fieldset>
				<fieldset class="fieldset">
					<legend class="fieldset-legend"><label for="add-file-content">Content (Markdown)</label></legend>
					<textarea id="add-file-content" class="textarea textarea-bordered min-h-48 text-sm" placeholder="File content..." bind:value={content} required></textarea>
				</fieldset>
				<div class="modal-action">
					<button type="button" class="btn btn-ghost btn-sm" onclick={handleCancel}>Cancel</button>
					<button type="submit" class="btn btn-primary btn-sm" disabled={busy || !name.trim() || !content.trim()}>
						{busy ? 'Adding...' : 'Add File'}
					</button>
				</div>
			</form>
		</div>
		<form method="dialog" class="modal-backdrop"><button>close</button></form>
	</dialog>
{/if}
