<script lang="ts">
	/**
	 * The host for `confirmDialog()`. Mounted once in the root layout; there is never more
	 * than one of these on screen, so it reads the pending request from module state
	 * rather than taking props.
	 *
	 * Plain DaisyUI `modal` markup, matching CreateProjectModal and the other dialogs in
	 * the app. An earlier version of this component wrapped a shared `Modal.svelte`; that
	 * abstraction is gone and nothing else uses it, so there is one modal idiom now.
	 */
	import { confirmState, settleConfirm } from './confirm-dialog.svelte';

	const confirmClass: Record<'primary' | 'danger' | 'warning', string> = {
		primary: 'btn-primary',
		danger: 'btn-error',
		warning: 'btn-warning'
	};

	// Focus the cancel button, not confirm. Most of these guard a delete, and a stray
	// Return should not be the thing that destroys a project.
	let cancelEl = $state<HTMLButtonElement | null>(null);
	$effect(() => {
		if (confirmState.pending) cancelEl?.focus();
	});
</script>

<svelte:window
	onkeydown={(event) => {
		if (event.key === 'Escape' && confirmState.pending) {
			event.preventDefault();
			settleConfirm(false);
		}
	}}
/>

{#if confirmState.pending}
	{@const pending = confirmState.pending}
	<!--
		`alertdialog`, not `dialog`: this interrupts to demand an answer, which is exactly
		what the role is for. It also keeps it distinguishable from the other `role="dialog"`
		surfaces on these pages — the memory panel, the mobile nav drawer — so a test does
		not have to guess which dialog it found.
	-->
	<div
		class="modal modal-open"
		role="alertdialog"
		aria-modal="true"
		aria-labelledby="confirm-dialog-title"
		aria-describedby="confirm-dialog-message"
	>
		<div class="modal-box max-w-md">
			<h2 id="confirm-dialog-title" class="text-lg font-bold">{pending.title}</h2>
			<p id="confirm-dialog-message" class="mt-2 text-sm whitespace-pre-line text-base-content/80">
				{pending.message}
			</p>
			<div class="modal-action">
				<button
					bind:this={cancelEl}
					class="btn btn-ghost btn-sm"
					type="button"
					onclick={() => settleConfirm(false)}
				>
					{pending.cancelLabel}
				</button>
				<button
					class="btn btn-sm {confirmClass[pending.variant]}"
					type="button"
					onclick={() => settleConfirm(true)}
				>
					{pending.confirmLabel}
				</button>
			</div>
		</div>
		<!-- Clicking the backdrop cancels, like the native dialog's dismiss. -->
		<button
			class="modal-backdrop"
			type="button"
			aria-label="Dismiss"
			onclick={() => settleConfirm(false)}
		></button>
	</div>
{/if}
