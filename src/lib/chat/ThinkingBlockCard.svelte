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

	const preview = $derived.by(() => {
		const normalized = content.replace(/\s+/g, ' ').trim();
		if (!normalized) {
			return live ? 'Thinking' : 'No reasoning captured';
		}
		return normalized.length > 110 ? `${normalized.slice(0, 107)}...` : normalized;
	});
	const tokenLabel = $derived(
		typeof reasoningTokens === 'number' && reasoningTokens > 0
			? `${reasoningTokens.toLocaleString()} thinking tokens`
			: null
	);
</script>

<details class="thinking-card rounded-xl border border-info/50 bg-info/10 transition-all duration-300" open={expanded}>
	<summary class="flex cursor-pointer items-center gap-3 px-4 py-3 select-none">
		<div class="flex h-7 w-7 shrink-0 items-center justify-center text-info">
			{#if live && !content.trim()}
				<span class="loading loading-spinner loading-xs"></span>
			{:else}
				<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M12 4a3 3 0 0 0-3 3v1" />
					<path d="M12 4a3 3 0 0 1 3 3v1" />
					<path d="M9 8a3 3 0 0 0-3 3a3 3 0 0 0 2 2.83" />
					<path d="M15 8a3 3 0 0 1 3 3a3 3 0 0 1-2 2.83" />
					<path d="M9 14.5a2.5 2.5 0 0 0 5 0" />
					<path d="M9 10.5v2.5" />
					<path d="M15 10.5v2.5" />
				</svg>
			{/if}
		</div>
		<div class="min-w-0 flex-1">
			<div class="flex items-center gap-2">
				<span class="text-sm font-semibold tracking-tight text-base-content/90">{live ? 'Thinking' : 'Thought process'}</span>
				{#if tokenLabel}
					<span class="rounded-full border border-info/35 bg-base-100/80 px-2 py-0.5 text-[11px] font-medium text-info/90">
						{tokenLabel}
					</span>
				{/if}
			</div>
			<p class="truncate text-xs text-base-content/60">{preview}</p>
		</div>
		<svg class="thinking-chevron h-4 w-4 shrink-0 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
			<polyline points="6 9 12 15 18 9" />
		</svg>
	</summary>

	<div class="px-4 pb-4">
		{#if content.trim()}
			<div class="markdown-body rounded-xl border border-base-300/65 bg-base-100/85 px-3 py-3 text-sm leading-6 text-base-content/85">{@html renderMarkdown(content)}</div>
		{:else}
			<div class="flex items-center gap-2 rounded-xl border border-dashed border-info/35 bg-base-100/55 px-3 py-3">
				<span class="loading loading-spinner loading-xs text-info"></span>
				<span class="sr-only">Thinking in progress</span>
			</div>
		{/if}
	</div>
</details>

<style>
	details .thinking-chevron {
		transition: transform 180ms ease;
	}

	details[open] .thinking-chevron {
		transform: rotate(180deg);
	}
</style>