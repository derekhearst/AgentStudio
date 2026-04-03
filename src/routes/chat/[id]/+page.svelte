<script lang="ts">
	import { page } from '$app/state';
	import {
		deleteMessagesAfter,
		editMessage,
		getConversation,
		getMessageStats
	} from '$lib/chat/chat.remote';
	import ChatInput from '$lib/components/chat/ChatInput.svelte';
	import ContextWindow from '$lib/components/chat/ContextWindow.svelte';
	import MessageBubble from '$lib/components/chat/MessageBubble.svelte';

	const conversationId = $derived(page.params.id ?? '');
	let model = $state('anthropic/claude-sonnet-4');
	let streaming = $state(false);
	let streamError = $state<string | null>(null);
	let draftAssistant = $state('');
	let pendingMessageId = $state<string | null>(null);
	let conversationData = $state<Awaited<ReturnType<typeof getConversation>> | null>(null);
	let stats = $state<Awaited<ReturnType<typeof getMessageStats>>>([]);

	$effect(() => {
		void loadConversationState();
	});

	const messages = $derived(conversationData?.messages ?? []);

	const usedTokens = $derived(stats.reduce((sum, row) => sum + row.tokensIn + row.tokensOut, 0));

	$effect(() => {
		if (conversationData?.conversation.model) {
			model = conversationData.conversation.model;
		}
	});

	async function loadConversationState() {
		if (!conversationId) {
			conversationData = null;
			stats = [];
			return;
		}

		const [conversationResult, statsResult] = await Promise.all([
			getConversation(conversationId),
			getMessageStats(conversationId)
		]);
		conversationData = conversationResult;
		stats = statsResult;
	}

	async function refreshAll() {
		await loadConversationState();
	}

	async function streamMessage(content: string, regenerate = false) {
		if (!conversationId) return;

		streaming = true;
		streamError = null;
		draftAssistant = '';
		pendingMessageId = null;
		try {
			const response = await fetch(`/chat/${conversationId}/stream`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ conversationId, content, model, regenerate })
			});

			if (!response.ok || !response.body) {
				throw new Error('Failed to open stream');
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const events = buffer.split('\n\n');
				buffer = events.pop() ?? '';

				for (const raw of events) {
					const lines = raw.split('\n');
					const eventLine = lines.find((line) => line.startsWith('event: '));
					const dataLine = lines.find((line) => line.startsWith('data: '));
					if (!eventLine || !dataLine) continue;

					const eventName = eventLine.slice(7).trim();
					const payload = JSON.parse(dataLine.slice(6));

					if (eventName === 'delta') {
						draftAssistant += payload.content ?? '';
					}

					if (eventName === 'done') {
						if (payload.error) {
							streamError = payload.error;
						} else if (payload.messageId) {
							// Keep draft visible until refreshAll() completes
							pendingMessageId = payload.messageId;
						}
					}
				}
			}
			await refreshAll();
		} catch (error) {
			streamError = error instanceof Error ? error.message : 'Streaming error';
		} finally {
			streaming = false;
			draftAssistant = '';
			pendingMessageId = null;
		}
	}

	async function handleEdit(messageId: string, content: string) {
		await editMessage({ messageId, content });
		await refreshAll();
	}

	async function handleRegenerate() {
		await streamMessage('regenerate', true);
	}

	async function handleTimelineJump(messageId: string) {
		if (!conversationId) return;
		await deleteMessagesAfter({ conversationId, messageId });
		await refreshAll();
	}

	async function compactContext() {
		console.log('Compact context requested for', conversationId);
	}
</script>

{#if !conversationData}
	<p class="text-sm opacity-70">Conversation not found.</p>
{:else}
	<section class="mx-auto flex max-w-3xl flex-col gap-4 py-4">
		<header class="rounded-2xl border border-base-300 bg-base-100 p-4">
			<h1 class="text-xl font-semibold">{conversationData.conversation.title}</h1>
			<p class="mt-1 text-sm opacity-70">Model: {model}</p>
		</header>

		<ContextWindow
			used={usedTokens}
			total={128000}
			reserved={8000}
			breakdown={{ system: 10, memories: 12, tools: 8, messages: 55, results: 15 }}
			onCompact={compactContext}
		/>

		<div class="max-h-[60vh] space-y-3 overflow-y-auto rounded-2xl border border-base-300 bg-base-100 p-4">
			{#each messages as message (message.id)}
				<MessageBubble message={message} onEdit={handleEdit} onRegenerate={handleRegenerate} />
			{/each}

			{#if draftAssistant && (streaming || pendingMessageId !== null)}
				<article class="chat chat-start">
					<div class="chat-header text-xs opacity-60">assistant {streaming ? '(streaming…)' : ''}</div>
					<div class="chat-bubble chat-bubble-neutral whitespace-pre-wrap">{draftAssistant}</div>
				</article>
			{/if}
		</div>

		{#if streamError}
			<p class="text-sm text-error">{streamError}</p>
		{/if}

		<ChatInput
			busy={streaming}
			model={model}
			onModelChange={(next) => {
				model = next;
			}}
			onSubmit={(content) => streamMessage(content, false)}
			estimatedRemaining={Math.max(0, 128000 - usedTokens)}
		/>
	</section>
{/if}

