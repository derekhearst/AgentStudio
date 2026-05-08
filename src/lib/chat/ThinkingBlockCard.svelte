<script lang="ts">
	import { renderMarkdown } from '$lib/chat/chat';
	import Icon from '$lib/chat-console/Icon.svelte';

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
			? `Thought for ${reasoningTokens.toLocaleString()} tokens`
			: live
				? 'Thinking…'
				: 'Thought process'
	);
</script>

<details class="console-think" open={expanded}>
	<summary>
		<span class="console-think__caret"><Icon name="caret" size={10} /></span>
		<Icon name="brain" size={13} />
		<span>{tokenLabel}</span>
	</summary>

	<div class="console-think__body">
		{#if content.trim()}
			<div class="markdown-body">{@html renderMarkdown(content)}</div>
		{:else if live}
			<div style="display:flex;align-items:center;gap:8px;font-size:11px;opacity:0.6;">
				<span class="loading loading-spinner loading-xs"></span>
				<span>Thinking in progress…</span>
			</div>
		{/if}
	</div>
</details>
