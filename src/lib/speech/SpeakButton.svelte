<script lang="ts">
	/**
	 * Read-aloud pill for an assistant reply (#27). Play reads the reply through `/api/tts`;
	 * while it is loading or playing the same pill stops it. A failure turns the icon red and
	 * puts the reason in the tooltip; pressing it again retries.
	 */
	import { speechPlayer } from './speech-player.svelte';

	let { messageId, text }: { messageId: string; text: string } = $props();

	const status = $derived(speechPlayer.statusOf(messageId));
	const failure = $derived(speechPlayer.errorOf(messageId));
	const label = $derived(
		status === 'loading'
			? 'Preparing audio… (click to stop)'
			: status === 'playing'
				? 'Stop reading aloud'
				: failure
					? `Read aloud failed: ${failure}`
					: 'Read aloud',
	);
</script>

<button
	class="console-pill"
	type="button"
	data-testid="speak-button"
	data-state={failure && status === 'idle' ? 'error' : status}
	aria-pressed={status !== 'idle'}
	title={label}
	aria-label={label}
	onclick={() => speechPlayer.toggle(messageId, text, { purpose: 'message' })}
>
	{#if status === 'loading'}
		<span class="loading loading-spinner" style="width:12px;height:12px;" aria-hidden="true"></span>
	{:else if status === 'playing'}
		<i class="mdi mdi-stop" aria-hidden="true"></i>
	{:else if failure}
		<i class="mdi mdi-volume-off text-error" aria-hidden="true"></i>
	{:else}
		<i class="mdi mdi-volume-high" aria-hidden="true"></i>
	{/if}
</button>
