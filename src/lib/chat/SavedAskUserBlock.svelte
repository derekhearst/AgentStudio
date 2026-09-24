<script lang="ts">
	import { renderMarkdown } from '$lib/chat/chat';
	import { savedAskUserExchanges } from './message-bubble-helpers';

	/**
	 * A question the agent asked, as a saved transcript shows it: the question as the
	 * assistant's text and the answer under it as the user's, so a reload reads the way the
	 * conversation went. Reads the SDK's AskUserQuestion (#4) — answers on the block's
	 * `details` — and the retired `ask_user`, whose answers are in its result.
	 *
	 * `alreadyShown` suppresses a question the model also wrote out in its own text.
	 */
	let {
		block,
		alreadyShown = () => false,
	}: {
		block: { name: string; arguments: unknown; result: unknown; details?: unknown; success?: boolean };
		alreadyShown?: (question: string) => boolean;
	} = $props();

	const exchanges = $derived(savedAskUserExchanges(block));
	const unanswered = $derived(block.success === false && exchanges.every((exchange) => !exchange.answer));
</script>

{#each exchanges as exchange, i (i)}
	{#if !alreadyShown(exchange.question)}
		<div class="assistant-message mb-2">
			<div class="markdown-body">{@html renderMarkdown(exchange.question)}</div>
		</div>
	{/if}
	{#if exchange.answer}
		<div class="mb-2 ml-auto w-fit max-w-[85%]">
			<div class="user-bubble bg-base-200/80 text-base-content rounded-2xl px-4 py-2.5 shadow-sm">
				<p class="whitespace-pre-wrap">{exchange.answer}</p>
			</div>
		</div>
	{/if}
{/each}
{#if unanswered && exchanges.length > 0}
	<p class="text-base-content/60 mb-2 text-xs">Not answered.</p>
{/if}
