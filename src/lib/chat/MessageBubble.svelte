<script lang="ts">
	import ToolCallCard from './ToolCallCard.svelte';
	import MessageBlocks from './MessageBlocks.svelte';
	import SpeakButton from '$lib/speech/SpeakButton.svelte';
	import { renderMarkdown } from '$lib/chat/chat';
	import {
		asArray,
		askQuestionAlreadyInMessage,
		blockHasRenderableOutput,
		getAskUserAnswer,
		getAskUserQuestions,
		type SavedBlock,
	} from './message-bubble-helpers';
	import type { ChatMessageMetadata, PersistedToolCall } from './streaming-blocks';

	type MessageRow = {
		id: string;
		role: 'user' | 'assistant' | 'system' | 'tool';
		content: string;
		model: string | null;
		tokensIn: number;
		tokensOut: number;
		cost: string;
		ttftMs: number | null;
		totalMs: number | null;
		tokensPerSec: number | null;
		createdAt: Date | string;
		// Wire shape from the DB jsonb column. PersistedToolCall names what the chat
		// domain itself produces; the broader fallback keeps historical rows + external
		// producers (sub-agents / automations) loading.
		toolCalls?: PersistedToolCall[] | Array<Record<string, unknown>>;
		/** Local-only bubble: the send has not been persisted yet. */
		optimistic?: boolean;
		metadata?: ChatMessageMetadata | null;
	};


	let {
		message,
		onEdit,
		onRegenerate,
		canRegenerate = false,
		canEdit = true,
		modelChanged = true,
	} = $props<{
		message: MessageRow;
		/** Resolves `false` when nothing was done (the user cancelled), which keeps the editor open. */
		onEdit?: ((messageId: string, content: string) => Promise<boolean | void> | boolean | void) | undefined;
		onRegenerate?: ((messageId: string) => Promise<void> | void) | undefined;
		canRegenerate?: boolean;
		/** False while a reply is streaming: an edit would cut the conversation out from under it. */
		canEdit?: boolean;
		/**
		 * Whether this message's model differs from the previous assistant message's.
		 * The tag is noise when it repeats down a whole conversation; it earns its place
		 * only where a switch actually happened. Token and cost figures stay available on
		 * the message's meta row either way.
		 */
		modelChanged?: boolean;
	}>();

	let editing = $state(false);
	let editingBusy = $state(false);
	let copied = $state(false);
	let copiedResetTimer: ReturnType<typeof setTimeout> | null = null;
	let draft = $state('');
	let editorRoot = $state<HTMLDivElement | null>(null);

	const showModelTag = $derived(Boolean(message.model) && modelChanged);
	const isUser = $derived(message.role === 'user');
	const isAssistant = $derived(message.role === 'assistant');
	const renderedAssistantMarkdown = $derived(isAssistant ? renderMarkdown(message.content ?? '') : '');
	const estimatedTokensOut = $derived(
		message.tokensOut > 0 ? message.tokensOut : Math.max(1, Math.ceil((message.content?.length ?? 0) / 4))
	);
	const estimatedTokensIn = $derived(
		message.tokensIn > 0 ? message.tokensIn : Math.max(1, Math.ceil((message.content?.length ?? 0) / 4))
	);
	const formattedCost = $derived(Number.parseFloat(message.cost || '0').toFixed(4));
	const messageReasoningTokens = $derived.by(() => {
		const value = message.metadata?.reasoningTokens;
		return typeof value === 'number' && value > 0 ? value : null;
	});

	/** #14 — the run that produced this reply; its page holds the full tool timeline. */
	const runId = $derived(typeof message.metadata?.runId === 'string' && message.metadata.runId ? message.metadata.runId : null);

	const savedBlocks = $derived.by(() => {
		const blocks = message.metadata?.blocks;
		return Array.isArray(blocks) ? (blocks as SavedBlock[]) : null;
	});

	type NormalizedToolCall = {
		name?: string | null;
		arguments?: unknown;
		result?: unknown;
		success?: boolean | null;
	};
	const normalizedToolCalls = $derived.by(() => asArray(message.toolCalls) as NormalizedToolCall[]);

	// Suppress empty assistant articles (interrupted streams, automation runs with no body).
	// User + system messages always render via a different branch in the template.
	const hasRenderableContent = $derived.by(() => {
		if (message.role !== 'assistant') return true
		if (savedBlocks && savedBlocks.length > 0) {
			return savedBlocks.some(blockHasRenderableOutput)
		}
		if (normalizedToolCalls.length > 0) return true
		return !!message.content?.trim()
	});

	// askQuestionAlreadyInMessage is imported; wrap it so call sites pass (question, blocks)
	// without re-passing message.content each time. Only the legacy normalizedToolCalls
	// branch still calls this directly — the savedBlocks path uses MessageBlocks which
	// has its own wrapper.
	const askQuestionAlreadyHere = (question: string | undefined, blocks: SavedBlock[] | null) =>
		askQuestionAlreadyInMessage(question, blocks, message.content);

	$effect(() => {
		if (!editing) return;

		const onPointerDown = (event: PointerEvent) => {
			// While a save is pending the page may be asking about restoring files (#24); a click
			// in that dialog is not a click away from the editor.
			if (editingBusy) return;
			const target = event.target;
			if (editorRoot && target instanceof Node && !editorRoot.contains(target)) {
				cancelEditing();
			}
		};

		const onEscape = (event: KeyboardEvent) => {
			if (event.key === 'Escape' && !editingBusy) {
				event.preventDefault();
				cancelEditing();
			}
		};

		window.addEventListener('pointerdown', onPointerDown, true);
		window.addEventListener('keydown', onEscape);
		return () => {
			window.removeEventListener('pointerdown', onPointerDown, true);
			window.removeEventListener('keydown', onEscape);
		};
	});

	function startEditing() {
		draft = message.content;
		editing = true;
		editingBusy = false;
	}

	function cancelEditing() {
		editing = false;
		editingBusy = false;
		draft = message.content;
	}

	async function submitEdit() {
		const trimmed = draft.trim();
		if (!trimmed || editingBusy) return;
		editingBusy = true;
		try {
			const done = await onEdit?.(message.id, trimmed);
			if (done !== false) editing = false;
		} finally {
			editingBusy = false;
		}
	}

	function handleEditorKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			void submitEdit();
		}
	}

	async function copyAssistantResponse() {
		if (!isAssistant || !message.content?.trim()) return;
		try {
			if (navigator?.clipboard?.writeText) {
				await navigator.clipboard.writeText(message.content);
			} else {
				const textarea = document.createElement('textarea');
				textarea.value = message.content;
				textarea.setAttribute('readonly', '');
				textarea.style.position = 'absolute';
				textarea.style.left = '-9999px';
				document.body.appendChild(textarea);
				textarea.select();
				document.execCommand('copy');
				document.body.removeChild(textarea);
			}
			copied = true;
			if (copiedResetTimer) clearTimeout(copiedResetTimer);
			copiedResetTimer = setTimeout(() => {
				copied = false;
				copiedResetTimer = null;
			}, 1200);
		} catch {
			copied = false;
		}
	}
</script>

{#if hasRenderableContent}
{@const ts = (() => { try { const d = new Date(message.createdAt); return isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); } catch { return ''; } })()}
<article
	class={`console-msg ${isUser ? 'console-msg--user' : 'console-msg--assist'}${message.optimistic ? ' console-msg--sending' : ''}`}
	aria-busy={message.optimistic ? 'true' : undefined}
>
	{#if isUser}
		{#if editing}
			<div bind:this={editorRoot} class="console-msg__edit">
				<textarea
					class="console-msg__edit-ta"
					rows="3"
					bind:value={draft}
					onkeydown={handleEditorKeydown}
					disabled={editingBusy}
				></textarea>
				<div class="console-msg__edit-row">
					<button class="console-pill" type="button" onclick={cancelEditing} disabled={editingBusy}>
						Cancel
					</button>
					<button class="console-pill console-pill--primary" type="button" onclick={submitEdit} disabled={!draft.trim() || editingBusy}>
						{editingBusy ? 'Updating…' : 'Save & regenerate'}
					</button>
				</div>
			</div>
		{:else}
			<div class="console-msg__user-wrap">
				{#if ts}<div class="console-msg__head"><span class="console-msg__time">{ts}</span></div>{/if}
				<div class="console-msg__user-bubble">
					<p class="whitespace-pre-wrap">{message.content}</p>
				</div>
				<div class="console-msg__actions">
					{#if canEdit}
						<button class="console-pill" type="button" onclick={startEditing} title="Edit message" aria-label="Edit message">
							<i class="mdi mdi-pencil-outline" aria-hidden="true"></i>
						</button>
					{/if}
					{#if canRegenerate}
						<button class="console-pill" type="button" onclick={() => onRegenerate?.(message.id)} title="Regenerate response" aria-label="Regenerate response">
							<i class="mdi mdi-refresh" aria-hidden="true"></i>
						</button>
					{/if}
				</div>
			</div>
		{/if}
	{:else}
		{#if ts || showModelTag}
			<div class="console-msg__head">
				{#if ts}<span class="console-msg__time">{ts}</span>{/if}
				{#if showModelTag}<span class="console-msg__model">{message.model}{message.tokensOut ? ` · ${message.tokensOut} tok` : ''}{Number.parseFloat(message.cost || '0') > 0 ? ` · $${formattedCost}` : ''}</span>{/if}
			</div>
		{/if}
		{#if savedBlocks}
			<MessageBlocks
				messageId={message.id}
				messageContent={message.content ?? ''}
				blocks={savedBlocks}
				{messageReasoningTokens}
			/>
		{:else}
		{#if normalizedToolCalls.length > 0}
			<div class="mb-2 w-full space-y-2">
				{#each normalizedToolCalls as call, idx (`${message.id}-${idx}`)}
				{#if call.name === 'ask_user'}
					{@const askQuestions = getAskUserQuestions(call.arguments, call.result)}
					{#if askQuestions.length > 0}
						{#each askQuestions as q}
							{#if !askQuestionAlreadyHere(q.question ?? q.header, savedBlocks)}
								<div class="assistant-message mb-2">
									<div class="markdown-body">{@html renderMarkdown(q.question ?? q.header)}</div>
								</div>
							{/if}
							{@const answer = getAskUserAnswer(call.result, q.header, askQuestions.map((question) => question.header))}
							{#if answer}
								<div class="console-msg console-msg--user">
									<div class="console-msg__user-wrap">
										<div class="console-msg__user-bubble">
											<p class="whitespace-pre-wrap">{answer}</p>
										</div>
									</div>
								</div>
							{/if}
						{/each}
					{/if}
				{:else}
					<ToolCallCard
						name={String(call.name ?? 'tool')}
						argumentsText={JSON.stringify(call.arguments ?? {}, null, 2)}
						result={typeof call.result === 'string' ? call.result : JSON.stringify(call.result ?? {}, null, 2)}
					/>
				{/if}
			{/each}
			</div>
		{/if}
		{#if message.content?.trim()}
			<div class="assistant-message">
				<div class="markdown-body">{@html renderedAssistantMarkdown}</div>
			</div>
		{/if}
		{/if}
	{/if}

	{#if !editing && isAssistant}
		<div class="console-msg__actions">
			<button
				class="console-pill"
				type="button"
				onclick={copyAssistantResponse}
				title="Copy response"
				aria-label="Copy response"
			>
				{#if copied}
					<i class="mdi mdi-check text-success" aria-hidden="true"></i>
				{:else}
					<i class="mdi mdi-content-copy" aria-hidden="true"></i>
				{/if}
			</button>
			{#if message.content?.trim() && !message.optimistic}
				<SpeakButton messageId={message.id} text={message.content} />
			{/if}
			<div class="dropdown dropdown-top">
				<button tabindex="0" class="console-pill" type="button" title="Message stats" aria-label="Message stats">
					<i class="mdi mdi-information-outline" aria-hidden="true"></i>
				</button>
				<div tabindex="0" role="menu" class="dropdown-content card card-compact bg-base-100 border-base-300 z-20 mt-2 w-72 border p-3 text-xs shadow-xl">
					<div class="grid grid-cols-2 gap-x-3 gap-y-2">
						<span class="opacity-70">Model</span>
						<span class="truncate text-right">{message.model ?? 'n/a'}</span>
						<span class="opacity-70">Tokens In</span>
						<span class="text-right">{estimatedTokensIn}</span>
						<span class="opacity-70">Tokens Out</span>
						<span class="text-right">{estimatedTokensOut}</span>
						{#if messageReasoningTokens !== null}
							<span class="opacity-70">Thinking</span>
							<span class="text-right">{messageReasoningTokens.toLocaleString()}</span>
						{/if}
						<span class="opacity-70">Cost</span>
						<span class="text-right">${formattedCost}</span>
						<span class="opacity-70">TTFT</span>
						<span class="text-right">{message.ttftMs ?? 'n/a'}{message.ttftMs !== null ? 'ms' : ''}</span>
						<span class="opacity-70">Total</span>
						<span class="text-right">{message.totalMs ?? 'n/a'}{message.totalMs !== null ? 'ms' : ''}</span>
						<span class="opacity-70">Tok/s</span>
						<span class="text-right">{message.tokensPerSec ?? 'n/a'}</span>
						{#if runId}
							<span class="opacity-70">Run</span>
							<a class="link link-hover text-right" href="/runs/{runId}" title="Every tool call and event in this run">Timeline</a>
						{/if}
					</div>
				</div>
			</div>
		</div>
	{/if}

</article>
{/if}
