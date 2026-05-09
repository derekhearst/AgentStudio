<script lang="ts">
	import type { Snippet } from 'svelte'

	/**
	 * Empty-state placeholder for lists that have no rows yet. Shows a title +
	 * one-line hint, optionally with an action button (or a custom action snippet
	 * for multi-button cases).
	 *
	 * Replaces the recurring inline pattern across the codebase:
	 *
	 *   <p class="py-6 text-center text-sm italic text-base-content/45">
	 *       No artifacts yet. Create one above to start version-tracking content.
	 *   </p>
	 *
	 * Density default ('default') matches the most common chat / list footer; pass
	 * `compact` for inline placements (sidebars, dropdowns) where vertical padding
	 * would push the rest of the surface offscreen.
	 */

	let {
		title,
		hint,
		actionLabel,
		onAction,
		variant = 'default',
		actions,
	}: {
		title: string
		hint?: string
		actionLabel?: string
		onAction?: () => void
		variant?: 'default' | 'compact'
		actions?: Snippet
	} = $props()

	const padding = $derived(variant === 'compact' ? 'py-3' : 'py-8')
</script>

<div class="flex flex-col items-center justify-center gap-2 text-center {padding}">
	<p class="text-sm font-medium text-base-content/70">{title}</p>
	{#if hint}
		<p class="text-xs text-base-content/45 max-w-md">{hint}</p>
	{/if}
	{#if actions}
		<div class="mt-2 flex gap-2">
			{@render actions()}
		</div>
	{:else if actionLabel && onAction}
		<button type="button" class="btn btn-primary btn-sm mt-2" onclick={onAction}>
			{actionLabel}
		</button>
	{/if}
</div>
