<script lang="ts">
	/**
	 * #24 — the host for `chooseFileRestore()`: what an edit or regenerate would restore, and
	 * whether to. Mounted once by the chat page; reads the pending request from module state,
	 * like `ConfirmDialog`.
	 *
	 * `confirmDialog` cannot carry a file list or a checkbox, which is the whole of this one:
	 * the files the dropped reply changed with their line counts, "also restore files"
	 * (ticked by default), and — for an imported repository with uncommitted changes in those
	 * files — a second, explicit box before anything is overwritten.
	 *
	 * Afterwards, `reportFileRestore()`'s notice when the restore left some listed files alone.
	 */
	import { untrack } from 'svelte';
	import { dismissFileRestoreNotice, rewindDialogState, settleFileRestore } from './rewind-dialog.svelte';
	import { canContinueRestore, restoreByDefault } from './rewind-preview';

	let restore = $state(false);
	let acknowledge = $state(false);
	let cancelEl = $state<HTMLButtonElement | null>(null);

	// A fresh request starts from the defaults, never from the last answer.
	$effect(() => {
		const pending = rewindDialogState.pending;
		if (!pending) return;
		untrack(() => {
			restore = restoreByDefault(pending.preview);
			acknowledge = false;
			cancelEl?.focus();
		});
	});

	const pending = $derived(rewindDialogState.pending);
	const preview = $derived(pending?.preview ?? null);
	const verb = $derived(pending?.action === 'edit' ? 'edit' : 'regenerate');
	const continueAllowed = $derived(preview ? canContinueRestore(preview, { restore, acknowledge }) : false);
	const uncommittedCount = $derived(preview?.files.filter((file) => file.uncommitted).length ?? 0);

	function confirm() {
		if (!preview || !continueAllowed) return;
		const restoring = restore && preview.canRewind;
		settleFileRestore({ restoreFiles: restoring, acknowledgeUncommitted: restoring && acknowledge });
	}
</script>

<svelte:window
	onkeydown={(event) => {
		if (event.key === 'Escape' && rewindDialogState.pending) {
			event.preventDefault();
			settleFileRestore(null);
		}
	}}
/>

{#if rewindDialogState.checking && !pending}
	<div class="toast toast-center toast-bottom z-50" role="status" aria-live="polite">
		<div class="alert text-sm shadow-lg">
			<span class="loading loading-spinner loading-xs" aria-hidden="true"></span>
			<span>Checking which files this would restore…</span>
		</div>
	</div>
{/if}

{#if rewindDialogState.notice && !pending}
	<div class="toast toast-center toast-top z-50">
		<div role="alert" class="alert alert-warning items-start text-sm shadow-lg" data-testid="rewind-notice">
			<span class="min-w-0">{rewindDialogState.notice}</span>
			<button type="button" class="btn btn-ghost btn-xs shrink-0" onclick={dismissFileRestoreNotice}>Dismiss</button>
		</div>
	</div>
{/if}

{#if pending && preview}
	<div
		class="modal modal-open"
		role="dialog"
		aria-modal="true"
		aria-labelledby="rewind-dialog-title"
		data-testid="rewind-dialog"
	>
		<div class="modal-box max-w-lg">
			<h2 id="rewind-dialog-title" class="text-lg font-bold">
				{pending.action === 'edit' ? 'Edit and regenerate' : 'Regenerate response'}
			</h2>

			{#if preview.canRewind}
				<p class="mt-2 text-sm text-base-content/80">
					The replies being replaced changed {preview.files.length}
					{preview.files.length === 1 ? 'file' : 'files'} in the workspace
					<span class="whitespace-nowrap tabular-nums">(+{preview.insertions} / −{preview.deletions} lines)</span>.
				</p>

				<label class="mt-3 flex cursor-pointer items-start gap-2 text-sm">
					<input
						type="checkbox"
						class="checkbox checkbox-sm mt-0.5 shrink-0"
						bind:checked={restore}
						data-testid="rewind-restore"
					/>
					<span class="min-w-0">Also restore these files to how they were before this message</span>
				</label>

				<ul
					class="border-base-300 bg-base-200/60 mt-2 max-h-48 overflow-y-auto rounded-lg border font-mono text-xs"
					aria-label="Files that would be restored"
				>
					{#each preview.files as file (file.path)}
						<li class="flex items-center gap-2 px-2 py-1">
							<span class="min-w-0 flex-1 break-all">{file.path}</span>
							{#if file.uncommitted}
								<span class="badge badge-warning badge-xs shrink-0">uncommitted</span>
							{/if}
						</li>
					{/each}
				</ul>

				{#if restore && uncommittedCount > 0}
					<div role="alert" class="alert alert-warning mt-3 items-start text-sm">
						<span class="min-w-0">
							{uncommittedCount === 1 ? 'One of these files has' : `${uncommittedCount} of these files have`}
							uncommitted changes. Restoring overwrites them — including any edits you made yourself since
							this message.
						</span>
					</div>
					{#if preview.requiresAcknowledge}
						<label class="mt-2 flex cursor-pointer items-start gap-2 text-sm">
							<input
								type="checkbox"
								class="checkbox checkbox-warning checkbox-sm mt-0.5 shrink-0"
								bind:checked={acknowledge}
								data-testid="rewind-acknowledge"
							/>
							<span class="min-w-0">Overwrite the uncommitted changes in these files</span>
						</label>
					{/if}
				{/if}

				<p class="mt-3 text-xs text-base-content/60">
					{#if restore && uncommittedCount === 0}
						Restoring puts these files back as they were, so any edits you made to them yourself since then are
						lost too.
					{/if}
					Only changes made with the agent's file tools are restored. Changes made by shell commands, and any
					commits or pushes, are not undone.
				</p>
			{:else}
				<p class="mt-2 text-sm text-base-content/80">
					The files can't be restored for this message: {preview.reason}
				</p>
				<p class="mt-2 text-sm text-base-content/80">You can still {verb} without restoring them.</p>
			{/if}

			<div class="modal-action">
				<button bind:this={cancelEl} class="btn btn-ghost btn-sm" type="button" onclick={() => settleFileRestore(null)}>
					Cancel
				</button>
				<button
					class="btn btn-primary btn-sm"
					type="button"
					onclick={confirm}
					disabled={!continueAllowed}
					data-testid="rewind-continue"
				>
					{restore && preview.canRewind ? 'Restore and continue' : 'Continue'}
				</button>
			</div>
		</div>
		<button
			class="modal-backdrop"
			type="button"
			aria-label="Dismiss"
			onclick={() => settleFileRestore(null)}
		></button>
	</div>
{/if}
