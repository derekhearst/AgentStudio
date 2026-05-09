<script lang="ts">
	import Modal from './Modal.svelte'

	/**
	 * Modal-based replacement for `window.confirm()`. Returns the decision via
	 * `onConfirm` / `onCancel` callbacks instead of a synchronous boolean — necessary
	 * because non-modal browsers (and our PWA shell) don't always render the native
	 * confirm cleanly, and because we want consistent styling.
	 *
	 * For destructive actions, set `variant="danger"` to switch the confirm button
	 * to btn-error so the operator's eye lands on the consequence first.
	 *
	 * Usage:
	 *
	 *   <ConfirmDialog
	 *       open={showDelete}
	 *       title="Delete project?"
	 *       message="All artifacts and versions will be lost."
	 *       confirmLabel="Delete"
	 *       variant="danger"
	 *       onConfirm={async () => { await runDelete(); showDelete = false }}
	 *       onCancel={() => (showDelete = false)}
	 *   />
	 */

	type Variant = 'primary' | 'danger' | 'warning'

	let {
		open,
		title,
		message,
		confirmLabel = 'Confirm',
		cancelLabel = 'Cancel',
		variant = 'primary',
		busy = false,
		onConfirm,
		onCancel,
	}: {
		open: boolean
		title: string
		message: string
		confirmLabel?: string
		cancelLabel?: string
		variant?: Variant
		busy?: boolean
		onConfirm: () => void | Promise<void>
		onCancel: () => void
	} = $props()

	const confirmClass: Record<Variant, string> = {
		primary: 'btn-primary',
		danger: 'btn-error',
		warning: 'btn-warning',
	}
</script>

<Modal {open} {title} size="md" onClose={onCancel}>
	{#snippet body()}
		<p class="text-sm text-base-content/80 whitespace-pre-line">{message}</p>
	{/snippet}
	{#snippet actions()}
		<button type="button" class="btn btn-ghost btn-sm" onclick={onCancel} disabled={busy}>
			{cancelLabel}
		</button>
		<button
			type="button"
			class="btn btn-sm {confirmClass[variant]}"
			onclick={onConfirm}
			disabled={busy}
		>
			{busy ? '…' : confirmLabel}
		</button>
	{/snippet}
</Modal>
