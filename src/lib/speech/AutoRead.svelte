<script lang="ts">
	/**
	 * Auto-read (#27): an opt-in switch that speaks each new assistant reply when its turn
	 * finishes, for hands-free use.
	 *
	 * The chat page hands over only its persisted `messages` and whether a turn is `streaming`.
	 * When a turn starts, the replies already on screen are remembered; when it ends — after
	 * the page has reloaded the conversation, so the saved reply is in `messages` — whatever is
	 * new is read. A reply saved as partial (Stop, or a failure) is not.
	 *
	 * The switch is per device (see `autoRead`) and starts off. Turning it on also primes the
	 * audio element from that tap, which is what lets a reply that arrives later start talking.
	 */
	import { onMount, untrack } from 'svelte';
	import { repliesToSpeak } from './speech';
	import { autoRead, speechPlayer } from './speech-player.svelte';

	type Reply = {
		id: string;
		role: string;
		content?: string | null;
		optimistic?: boolean;
		metadata?: unknown;
	};

	let { messages, streaming }: { messages: readonly Reply[]; streaming: boolean } = $props();

	// The preference lives in localStorage, which the server render cannot see; showing it
	// only after mount keeps the first client render identical to the server's.
	let mounted = $state(false);
	onMount(() => {
		mounted = true;
	});
	const enabled = $derived(mounted && autoRead.enabled);
	const reading = $derived(speechPlayer.activePurpose === 'autoplay');

	/** Assistant replies that existed when the running turn began; null between turns. */
	let known: Set<string> | null = null;
	/** The reply auto-read last tried, so a failure to read it can be shown here. */
	let lastReadId = $state<string | null>(null);
	const failure = $derived(lastReadId ? speechPlayer.errorOf(lastReadId) : null);

	$effect(() => {
		const live = streaming;
		untrack(() => {
			if (live) {
				known ??= new Set(messages.filter((m) => m.role === 'assistant').map((m) => m.id));
				return;
			}
			if (!known) return;
			const fresh = repliesToSpeak(known, messages);
			known = null;
			if (!autoRead.enabled || fresh.length === 0) return;
			lastReadId = fresh[fresh.length - 1].id;
			void speechPlayer.play(
				lastReadId,
				fresh.map((m) => m.content ?? '').join('\n\n'),
				{ purpose: 'autoplay' },
			);
		});
	});

	function toggle() {
		autoRead.enabled = !autoRead.enabled;
		if (autoRead.enabled) speechPlayer.unlock();
		else if (reading) speechPlayer.stop();
	}
</script>

<div class="auto-read">
	{#if failure && !reading}
		<span class="auto-read__error" role="status" title={failure} data-testid="auto-read-error">Couldn't read the reply aloud: {failure}</span>
	{/if}
	{#if reading}
		<button
			type="button"
			class="console-pill"
			data-testid="auto-read-stop"
			title="Stop reading this reply"
			aria-label="Stop reading this reply"
			onclick={() => speechPlayer.stop()}
		>
			<i class="mdi mdi-stop" aria-hidden="true"></i>
			Stop
		</button>
	{/if}
	<button
		type="button"
		class="console-pill"
		class:auto-read--on={enabled}
		data-testid="auto-read-toggle"
		aria-pressed={enabled}
		title={enabled
			? 'New replies are read aloud when they finish. Click to turn off.'
			: 'Read new replies aloud when they finish (this device only)'}
		onclick={toggle}
	>
		<i class={`mdi ${enabled ? 'mdi-account-voice' : 'mdi-account-voice-off'}`} aria-hidden="true"></i>
		Auto-read {enabled ? 'on' : 'off'}
	</button>
</div>

<style>
	.auto-read {
		display: flex;
		justify-content: flex-end;
		gap: 6px;
		padding: 2px 12px 4px;
	}
	.auto-read__error {
		align-self: center;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 11px;
		color: var(--color-error);
	}
	.auto-read--on {
		border-color: var(--color-primary);
		color: var(--color-primary);
	}
</style>
