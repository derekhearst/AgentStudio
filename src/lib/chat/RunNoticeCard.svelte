<script lang="ts">
	import Icon from '$lib/chat-console/Icon.svelte';
	import type { RunNotice } from '$lib/engine/sdk-notices';

	/**
	 * A run-level event the SDK reported: a compaction boundary, an API retry, a model
	 * fallback, a tool a permission rule refused (see `$lib/engine/sdk-notices`).
	 *
	 * Deliberately quieter than a tool card and visibly not the assistant speaking. These
	 * explain the run rather than advance it, and a notice that competes with the reply for
	 * attention is one people learn to scroll past.
	 */

	let { notice }: { notice: RunNotice } = $props();

	const icon = $derived(
		notice.kind === 'compacted'
			? 'refresh'
			: notice.kind === 'permission_denied'
				? 'x'
				: notice.level === 'info'
					? 'chat'
					: 'alert'
	);
</script>

<div class={`console-notice is-${notice.level}`}>
	<span class="console-notice__icon"><Icon name={icon} size={11} /></span>
	<div class="console-notice__body">
		<span class="console-notice__title">{notice.title}</span>
		{#if notice.detail}
			<p class="console-notice__detail">{notice.detail}</p>
		{/if}
	</div>
</div>
