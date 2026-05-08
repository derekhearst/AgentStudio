<script lang="ts">
	let {
		open,
		skillMd,
		resources = [],
		onClose,
	} = $props<{
		open: boolean
		skillMd: string
		resources?: Array<{ name: string; description?: string; content: string }>
		onClose: () => void
	}>()

	let dialogEl = $state<HTMLDialogElement | undefined>(undefined)
	let copied = $state(false)

	$effect(() => {
		if (open) {
			copied = false
			setTimeout(() => dialogEl?.showModal(), 0)
		}
	})

	async function copyExportText() {
		const text =
			resources.length === 0
				? skillMd
				: [
						skillMd,
						'',
						'---',
						'',
						...resources.map(
							(r: { name: string; description?: string; content: string }) =>
								`## resources/${r.name}\n\n${r.content}`,
						),
					].join('\n')
		try {
			await navigator.clipboard.writeText(text)
			copied = true
			setTimeout(() => (copied = false), 2000)
		} catch {
			// Clipboard API can fail in non-secure contexts; user can still select + copy manually.
		}
	}

	function handleClose() {
		dialogEl?.close()
		onClose()
	}
</script>

{#if open}
	<dialog bind:this={dialogEl} class="modal" onclose={onClose}>
		<div class="modal-box max-w-3xl">
			<div class="mb-3 flex items-center justify-between gap-3">
				<div>
					<h3 class="text-lg font-bold">Export as SKILL.md package</h3>
					<p class="mt-0.5 text-xs opacity-60">Round-trip-clean — paste into the Import dialog on /skills to recreate this skill.</p>
				</div>
				<button class="btn btn-ghost btn-xs" onclick={copyExportText}>
					{copied ? 'Copied!' : 'Copy all'}
				</button>
			</div>
			<div class="space-y-3">
				<div>
					<div class="mb-1 text-xs font-semibold uppercase tracking-wider opacity-40">SKILL.md</div>
					<pre class="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-base-200 p-3 font-mono text-xs">{skillMd}</pre>
				</div>
				{#if resources.length > 0}
					<div>
						<div class="mb-1 text-xs font-semibold uppercase tracking-wider opacity-40">Resource files ({resources.length})</div>
						<div class="space-y-2">
							{#each resources as r (r.name)}
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
				<button type="button" class="btn btn-ghost btn-sm" onclick={handleClose}>Close</button>
			</div>
		</div>
		<form method="dialog" class="modal-backdrop"><button>close</button></form>
	</dialog>
{/if}
