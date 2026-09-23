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
	 * The switch survives a reload and the primed element does not, so while it is on, the
	 * first tap or key press on the page (sending the next message, typically) primes it again.
	 *
	 * It also carries the Stop button for any reply being read, auto-read or not: a reply's own
	 * speaker button only shows while that message is hovered, and a long reply keeps talking
	 * after the pointer or the scroll has moved on.
	 *
	 * The page is reused across conversations, so this also owns what happens on leaving one:
	 * a reply still being read stops (its speaker button is no longer on screen to stop it),
	 * and a turn that ends after the move reads nothing from the conversation now shown.
	 */
	import { onMount, untrack } from 'svelte';
	import { page } from '$app/state';
	import { repliesToSpeak, startTurn, type TurnStart } from './speech';
	import { autoRead, speechPlayer } from './speech-player.svelte';

	type Reply = {
		id: string;
		role: string;
		conversationId: string;
		content?: string | null;
		optimistic?: boolean;
		metadata?: unknown;
	};

	let { messages, streaming }: { messages: readonly Reply[]; streaming: boolean } = $props();

	const conversationId = $derived(page.params.id ?? '');

	// The preference lives in localStorage, which the server render cannot see; showing it
	// only after mount keeps the first client render identical to the server's.
	let mounted = $state(false);
	onMount(() => {
		mounted = true;
	});
	const enabled = $derived(mounted && autoRead.enabled);
	/** Auto-read started what is playing: turning the switch off stops it. */
	const reading = $derived(speechPlayer.activePurpose === 'autoplay');
	/** A reply from this conversation is being read, by auto-read or its speaker button. */
	const replyPlaying = $derived(speechPlayer.activePurpose === 'autoplay' || speechPlayer.activePurpose === 'message');

	/** The running turn's conversation and the replies it already held; null between turns. */
	let turn: TurnStart | null = null;
	/** The reply auto-read last tried, so a failure to read it can be shown here. */
	let lastReadId = $state<string | null>(null);
	const failure = $derived(lastReadId ? speechPlayer.errorOf(lastReadId) : null);

	$effect(() => {
		const live = streaming;
		untrack(() => {
			if (live) {
				turn ??= startTurn(conversationId, messages);
				return;
			}
			if (!turn) return;
			const fresh = repliesToSpeak(turn, messages);
			turn = null;
			if (!autoRead.enabled || fresh.length === 0) return;
			lastReadId = fresh[fresh.length - 1].id;
			void speechPlayer.play(
				lastReadId,
				fresh.map((m) => m.content ?? '').join('\n\n'),
				{ purpose: 'autoplay' },
			);
		});
	});

	// Re-prime after a reload (see the header). iOS counts the end of a touch as the tap, not
	// its start, so every event that may carry the gesture is listened to until one primes it.
	$effect(() => {
		if (!enabled) return;
		const events = ['pointerup', 'touchend', 'keydown'] as const;
		const stopListening = () => {
			for (const type of events) window.removeEventListener(type, prime, true);
		};
		function prime() {
			void speechPlayer.unlock().then((primed) => {
				if (primed) stopListening();
			});
		}
		for (const type of events) window.addEventListener(type, prime, true);
		return stopListening;
	});

	// Leaving the conversation, for another one or another page, stops a reply being read
	// from it, and drops its failure notice. Only replies: the settings preview is not this
	// page's to stop.
	$effect(() => {
		void conversationId;
		return () =>
			untrack(() => {
				const purpose = speechPlayer.activePurpose;
				if (purpose === 'message' || purpose === 'autoplay') speechPlayer.stop();
				lastReadId = null;
			});
	});

	function toggle() {
		autoRead.enabled = !autoRead.enabled;
		if (autoRead.enabled) void speechPlayer.unlock();
		else if (reading) speechPlayer.stop();
	}
</script>

<div class="auto-read">
	{#if failure && !replyPlaying}
		<span class="auto-read__error" role="status" title={failure} data-testid="auto-read-error">Couldn't read the reply aloud: {failure}</span>
	{/if}
	{#if replyPlaying}
		<button
			type="button"
			class="console-pill"
			data-testid="read-aloud-stop"
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
