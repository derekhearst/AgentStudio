<script lang="ts">
	import Icon from '$lib/chat-console/Icon.svelte';

	/**
	 * The failure notice for a chat turn.
	 *
	 * It replaced a full-width red slab reading "Run failed" and nothing else, which told
	 * you that something broke but never what, and looked alarming out of proportion to
	 * causes as ordinary as "you pressed stop".
	 *
	 * Two ideas here. First, the raw message is classified into a cause, because "the run
	 * never started", "the model was interrupted" and "a tool was refused" want different
	 * reactions from the reader. Second, the notice is sized to its severity: a calm inline
	 * card rather than a banner, with the underlying text kept and shown, since the exact
	 * string is what makes a bug reportable.
	 */

	let {
		message,
		canRetry = false,
		retrying = false,
		busy = false,
		onRetry,
		onDismiss,
	}: {
		message: string;
		canRetry?: boolean;
		retrying?: boolean;
		busy?: boolean;
		onRetry?: () => void;
		onDismiss?: () => void;
	} = $props();

	type Cause = {
		title: string;
		hint: string;
		icon: 'branch' | 'check' | 'plus';
		tone: 'neutral' | 'warn' | 'error';
	};

	/**
	 * Map a raw error string onto something a reader can act on.
	 *
	 * Deliberately conservative: anything unrecognised keeps its own text as the title
	 * rather than being flattened into a generic "Something went wrong", which would throw
	 * away the only specific information available.
	 */
	const cause = $derived.by<Cause>(() => {
		const raw = (message ?? '').trim();
		const lower = raw.toLowerCase();

		if (lower.includes('interrupted') || lower.includes('abort')) {
			return {
				title: 'The reply was interrupted',
				hint: 'The connection closed before the model finished. Retrying resends the same message.',
				icon: 'branch',
				tone: 'neutral',
			};
		}
		if (lower === 'run failed' || lower.includes('run failed')) {
			return {
				title: "The run didn't start",
				hint: 'The engine stopped before the model produced anything. This is usually a server-side configuration problem rather than something about your message.',
				icon: 'branch',
				tone: 'error',
			};
		}
		if (lower.includes('denied') || lower.includes('refused') || lower.includes('permission')) {
			return {
				title: 'A tool call was refused',
				hint: 'The agent tried something the current permission mode or approval settings do not allow.',
				icon: 'check',
				tone: 'warn',
			};
		}
		if (lower.includes('budget') || lower.includes('limit')) {
			return {
				title: 'A spending limit stopped this run',
				hint: 'Raise the cap in Settings → Budget, or wait for the window to reset.',
				icon: 'check',
				tone: 'warn',
			};
		}
		if (lower.includes('gateway') || lower.includes('model')) {
			return {
				title: 'The model could not be reached',
				hint: 'Check the model selection, and that any gateway it needs is configured.',
				icon: 'branch',
				tone: 'error',
			};
		}
		return {
			title: raw.length > 0 ? raw : 'The run did not finish',
			hint: '',
			icon: 'branch',
			tone: 'error',
		};
	});

	// Only worth repeating the raw string when the title is a friendlier rewrite of it.
	const showRaw = $derived(cause.title !== (message ?? '').trim() && (message ?? '').trim().length > 0);
</script>

<div class="chat-error chat-error--{cause.tone}" role="status" aria-live="polite">
	<span class="chat-error__icon" aria-hidden="true"><Icon name={cause.icon} size={13} /></span>

	<div class="chat-error__body">
		<p class="chat-error__title">{cause.title}</p>
		{#if cause.hint}<p class="chat-error__hint">{cause.hint}</p>{/if}
		{#if showRaw}<p class="chat-error__raw"><code>{message}</code></p>{/if}
	</div>

	<div class="chat-error__actions">
		{#if canRetry}
			<button type="button" class="chat-error__btn chat-error__btn--primary" onclick={onRetry} disabled={busy}>
				{retrying ? 'Retrying…' : 'Retry'}
			</button>
		{/if}
		<button type="button" class="chat-error__btn" onclick={onDismiss} disabled={retrying}>Dismiss</button>
	</div>
</div>

<style>
	.chat-error {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		margin: 6px 0 2px;
		padding: 10px 12px;
		border: 1px solid var(--color-base-300);
		border-left-width: 3px;
		border-radius: 8px;
		background: var(--color-base-200);
		font-size: 12.5px;
		line-height: 1.5;
	}
	/* Tone lives on the left edge only. A whole red panel reads as a system outage even
	   when the cause was the user pressing stop. */
	.chat-error--neutral {
		border-left-color: var(--color-base-content);
	}
	.chat-error--warn {
		border-left-color: var(--color-warning);
	}
	.chat-error--error {
		border-left-color: var(--color-error);
	}

	.chat-error__icon {
		margin-top: 1px;
		opacity: 0.6;
		flex-shrink: 0;
	}
	.chat-error__body {
		min-width: 0;
		flex: 1;
	}
	.chat-error__title {
		margin: 0;
		font-weight: 600;
	}
	.chat-error__hint {
		margin: 2px 0 0;
		opacity: 0.7;
	}
	.chat-error__raw {
		margin: 6px 0 0;
		overflow-wrap: anywhere;
	}
	.chat-error__raw code {
		font-size: 11.5px;
		opacity: 0.65;
	}

	.chat-error__actions {
		display: flex;
		gap: 6px;
		flex-shrink: 0;
	}
	.chat-error__btn {
		padding: 3px 10px;
		border: 1px solid var(--color-base-300);
		border-radius: 6px;
		background: transparent;
		font-size: 11.5px;
		cursor: pointer;
	}
	.chat-error__btn:hover:not(:disabled) {
		background: var(--color-base-300);
	}
	.chat-error__btn:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.chat-error__btn--primary {
		border-color: var(--color-primary);
		color: var(--color-primary);
	}

	@media (max-width: 640px) {
		.chat-error {
			flex-wrap: wrap;
		}
		.chat-error__actions {
			width: 100%;
			justify-content: flex-end;
		}
	}
</style>
