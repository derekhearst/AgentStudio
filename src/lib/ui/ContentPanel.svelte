<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		header,
		actions,
		children,
		footer,
		compact = false,
		flush = false,
		bare = false,
		class: className = '',
	}: {
		header?: Snippet;
		actions?: Snippet;
		children?: Snippet;
		footer?: Snippet;
		compact?: boolean;
		flush?: boolean;
		bare?: boolean;
		class?: string;
	} = $props();

	const hasBar = $derived(!!header || !!actions);
</script>

<section
	class="{bare ? 'flex h-full flex-col' : `rounded-xl border border-base-300 bg-base-100 sm:rounded-2xl ${compact ? 'p-2 sm:p-3' : 'p-2.5 sm:p-4'}`} {className}"
>
	{#if hasBar}
		<div class="flex flex-wrap items-center justify-between gap-2">
			{#if header}
				<div class="min-w-0 flex-1">{@render header()}</div>
			{/if}
			{#if actions}
				<div class="flex items-center gap-2">{@render actions()}</div>
			{/if}
		</div>
	{/if}
	{#if children}
		<div class={hasBar && !flush ? 'mt-3' : ''} class:flex-1={bare} class:overflow-y-auto={bare}>
			{@render children()}
		</div>
	{/if}
	{#if footer}
		<div class="shrink-0">
			{@render footer()}
		</div>
	{/if}
</section>
