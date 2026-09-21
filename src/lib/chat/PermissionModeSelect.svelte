<script lang="ts">
	/**
	 * #19 — the per-conversation permission mode picker.
	 *
	 * Self-contained on purpose: it owns the confirm for `bypassPermissions` and the remote
	 * call, so mounting it anywhere costs one line. The chat page's topbar and mobile chip
	 * row both use it.
	 *
	 * The confirm is a UI courtesy, not the control — `setConversationPermissionMode` refuses
	 * `bypassPermissions` without `confirmed: true` server-side as well.
	 */
	import { setConversationPermissionMode } from '$lib/chat/chat.remote';
	import {
		describePermissionMode,
		normalizePermissionMode,
		PERMISSION_MODES,
		PERMISSION_MODE_LABELS,
		requiresExplicitConfirm,
		type ConversationPermissionMode,
	} from '$lib/engine/permission-mode';

	let {
		conversationId,
		permissionMode = 'default',
		disabled = false,
		onChange,
	}: {
		conversationId: string;
		permissionMode?: ConversationPermissionMode | string | null;
		disabled?: boolean;
		onChange?: ((mode: ConversationPermissionMode) => void) | undefined;
	} = $props();

	let busy = $state(false);
	let error = $state<string | null>(null);

	const current = $derived(normalizePermissionMode(permissionMode));
	const isBypass = $derived(current === 'bypassPermissions');

	async function pick(event: Event) {
		const select = event.currentTarget as HTMLSelectElement;
		const next = normalizePermissionMode(select.value);
		if (next === current) return;

		let confirmed = false;
		if (requiresExplicitConfirm(next)) {
			confirmed =
				typeof window !== 'undefined' &&
				window.confirm(
					`Switch this conversation to "${PERMISSION_MODE_LABELS[next]}"?\n\n${describePermissionMode(next)}\n\nPushes, pull requests and plan handoffs will still ask.`
				);
			if (!confirmed) {
				select.value = current;
				return;
			}
		}

		busy = true;
		error = null;
		try {
			await setConversationPermissionMode({ conversationId, mode: next, confirmed });
			onChange?.(next);
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
			select.value = current;
		} finally {
			busy = false;
		}
	}
</script>

<label
	class="console-chip"
	class:is-warn={isBypass}
	title={describePermissionMode(current)}
	data-testid="permission-mode-select"
	data-permission-mode={current}
>
	<span class="sr-only">Permission mode</span>
	<select
		class="cursor-pointer border-0 bg-transparent p-0 text-inherit outline-none"
		value={current}
		disabled={disabled || busy}
		onchange={pick}
		aria-label="Permission mode for this conversation"
	>
		{#each PERMISSION_MODES as modeOption (modeOption)}
			<option value={modeOption}>{PERMISSION_MODE_LABELS[modeOption]}</option>
		{/each}
	</select>
</label>
{#if error}
	<span class="console-chip is-warn" role="alert">{error}</span>
{/if}
