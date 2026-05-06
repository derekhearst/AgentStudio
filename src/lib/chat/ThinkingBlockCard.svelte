<script lang="ts">
	import { renderMarkdown } from '$lib/chat/chat';

	let {
		content = '',
		reasoningTokens = null,
		expanded = false,
		live = false,
	} = $props<{
		content?: string;
		reasoningTokens?: number | null;
		expanded?: boolean;
		live?: boolean;
	}>();

	const tokenLabel = $derived(
		typeof reasoningTokens === 'number' && reasoningTokens > 0
			? `${reasoningTokens.toLocaleString()} thinking tokens`
			: null
	);
</script>

<details class="thinking-block group" open={expanded}>
	<summary class="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm font-normal select-none text-base-content/55 transition-colors hover:text-base-content/80 hover:bg-base-200/40">
		<svg class="thinking-chevron h-3 w-3 shrink-0 opacity-60 transition-transform" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
			<polyline points="9 18 15 12 9 6" />
		</svg>
		{#if live && !content.trim()}
			<span class="loading loading-spinner loading-xs text-base-content/50"></span>
		{:else}
			<i class="mdi mdi-brain text-base opacity-55" aria-hidden="true"></i>
		{/if}
		<span class="italic">{live ? 'Thinking…' : 'Thought process'}</span>
		{#if tokenLabel}
			<span class="text-[11px] opacity-60">· {tokenLabel}</span>
		{/if}
	</summary>

	<div class="ml-2 mt-1 mb-2 border-l-2 border-base-300/45 pl-3">
		{#if content.trim()}
			<div class="markdown-body text-sm italic leading-6 text-base-content/60">{@html renderMarkdown(content)}</div>
		{:else}
			<div class="flex items-center gap-2 text-xs text-base-content/50">
				<span class="loading loading-spinner loading-xs"></span>
				<span>Thinking in progress…</span>
			</div>
		{/if}
	</div>
</details>

<style>
	.thinking-block > summary {
		list-style: none;
	}
	.thinking-block > summary::-webkit-details-marker {
		display: none;
	}
	.thinking-block[open] > summary > .thinking-chevron {
		transform: rotate(90deg);
	}
</style>
