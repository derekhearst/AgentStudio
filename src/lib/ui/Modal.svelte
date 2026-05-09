<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * Generic modal shell. Wraps a `<dialog>` with the project's daisyUI styling so
	 * callers don't have to re-derive the open/close lifecycle, the backdrop close
	 * button, the focus management, or the modal-action footer.
	 *
	 * Usage:
	 *
	 *   <Modal {open} title="Edit thing" onClose={() => open = false}>
	 *       {#snippet body()}
	 *           <p>Body content</p>
	 *       {/snippet}
	 *       {#snippet actions()}
	 *           <button class="btn btn-ghost btn-sm" onclick={cancel}>Cancel</button>
	 *           <button class="btn btn-primary btn-sm" onclick={save}>Save</button>
	 *       {/snippet}
	 *   </Modal>
	 */

	type Size = 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl'

	let {
		open,
		title,
		size = 'lg',
		onClose,
		body,
		actions,
		header,
	}: {
		open: boolean
		title?: string
		size?: Size
		onClose: () => void
		body: Snippet
		actions?: Snippet
		/** Optional override for the title row when a plain string isn't enough. */
		header?: Snippet
	} = $props()

	let dialogEl = $state<HTMLDialogElement | undefined>(undefined)

	const sizeClass: Record<Size, string> = {
		sm: 'max-w-sm',
		md: 'max-w-md',
		lg: 'max-w-2xl',
		xl: 'max-w-3xl',
		'2xl': 'max-w-4xl',
		'3xl': 'max-w-5xl',
	}

	$effect(() => {
		if (open) {
			// Defer one tick so the bind:this completes before showModal().
			setTimeout(() => dialogEl?.showModal(), 0)
		} else {
			dialogEl?.close()
		}
	})
</script>

{#if open}
	<dialog bind:this={dialogEl} class="modal" onclose={onClose}>
		<div class="modal-box {sizeClass[size]}">
			{#if header}
				{@render header()}
			{:else if title}
				<h3 class="mb-4 text-lg font-bold">{title}</h3>
			{/if}
			{@render body()}
			{#if actions}
				<div class="modal-action">
					{@render actions()}
				</div>
			{/if}
		</div>
		<form method="dialog" class="modal-backdrop"><button aria-label="Close">close</button></form>
	</dialog>
{/if}
