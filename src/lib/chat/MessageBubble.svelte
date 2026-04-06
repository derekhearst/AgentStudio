<script lang="ts">
	import ToolCallCard from './ToolCallCard.svelte';
	import ArtifactPreviewCard from '$lib/artifacts/ArtifactPreviewCard.svelte';
	import { renderMarkdown } from '$lib/chat/chat';

	type ArtifactPreview = {
		id: string;
		type: string;
		title: string;
		content: string;
		language: string | null;
		messageId: string | null;
	};

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
		toolCalls?: Array<Record<string, unknown>>;
	};

	let {
		message,
		artifacts = [],
		onEdit,
		onRegenerate,
		onOpenArtifact,
	} = $props<{
		message: MessageRow;
		artifacts?: ArtifactPreview[];
		onEdit?: ((messageId: string, content: string) => Promise<void> | void) | undefined;
		onRegenerate?: ((messageId: string) => Promise<void> | void) | undefined;
		onOpenArtifact?: ((artifactId: string) => void) | undefined;
	}>();

	const messageArtifacts = $derived(
		artifacts.filter((a: ArtifactPreview) => a.messageId === message.id)
	);

	let editing = $state(false);
	let draft = $state('');

	const isUser = $derived(message.role === 'user');
	const isAssistant = $derived(message.role === 'assistant');
	const renderedAssistantMarkdown = $derived(
		isAssistant && !editing ? renderMarkdown(message.content ?? '') : ''
	);
	const estimatedTokensOut = $derived(
		message.tokensOut > 0 ? message.tokensOut : Math.max(1, Math.ceil((message.content?.length ?? 0) / 4))
	);
	const estimatedTokensIn = $derived(
		message.tokensIn > 0 ? message.tokensIn : Math.max(1, Math.ceil((message.content?.length ?? 0) / 4))
	);
	const formattedCost = $derived(Number.parseFloat(message.cost || '0').toFixed(4));

	async function submitEdit() {
		if (!draft.trim()) return;
		await onEdit?.(message.id, draft.trim());
		editing = false;
	}

	function startEditing() {
		draft = message.content;
		editing = true;
	}
</script>

<article class={`chat-message w-full ${isUser ? 'chat chat-end' : ''}`}>
	{#if !isUser && message.toolCalls && message.toolCalls.length > 0}
		<div class="mb-2 w-full space-y-2 pl-2">
			{#each message.toolCalls as call, idx (`${message.id}-${idx}`)}
				<ToolCallCard
					name={String(call.name ?? 'tool')}
					argumentsText={JSON.stringify(call.arguments ?? {}, null, 2)}
					result={typeof call.result === 'string' ? call.result : JSON.stringify(call.result ?? {}, null, 2)}
				/>
			{/each}
		</div>
	{/if}

	{#if isUser}
		<div class="max-w-[90%] rounded-2xl border-2 border-primary bg-base-100/60 px-4 py-3">
			{#if editing}
				<textarea class="textarea textarea-bordered w-full" bind:value={draft}></textarea>
				<div class="mt-2 flex gap-2">
					<button class="btn btn-xs btn-primary" type="button" onclick={submitEdit}>Save</button>
					<button class="btn btn-xs" type="button" onclick={() => (editing = false)}>Cancel</button>
				</div>
			{:else}
				<p class="whitespace-pre-wrap">{message.content}</p>
			{/if}
		</div>
	{:else}
		<div class="assistant-message pl-4">
			{#if editing}
				<textarea class="textarea textarea-bordered w-full" bind:value={draft}></textarea>
				<div class="mt-2 flex gap-2">
					<button class="btn btn-xs btn-primary" type="button" onclick={submitEdit}>Save</button>
					<button class="btn btn-xs" type="button" onclick={() => (editing = false)}>Cancel</button>
				</div>
			{:else}
				<div class="markdown-body">{@html renderedAssistantMarkdown}</div>
			{/if}
		</div>
	{/if}

	{#if !editing}
		<div class={`chat-footer mt-1 flex w-full items-center gap-1 ${isUser ? 'justify-end' : 'justify-start'}`}>
			{#if isUser}
				<button class="btn btn-ghost btn-xs btn-circle" type="button" onclick={startEditing} title="Edit message" aria-label="Edit message">
					<svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<path d="M12 20h9"></path>
						<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path>
					</svg>
				</button>
			{/if}
			{#if isAssistant}
				<button class="btn btn-ghost btn-xs rounded-md px-2" type="button" onclick={() => onRegenerate?.(message.id)} title="Regenerate response" aria-label="Regenerate response">
					<svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<polyline points="23 4 23 10 17 10"></polyline>
						<polyline points="1 20 1 14 7 14"></polyline>
						<path d="M3.5 9a9 9 0 0 1 14.1-3.4L23 10"></path>
						<path d="M20.5 15a9 9 0 0 1-14.1 3.4L1 14"></path>
					</svg>
				</button>
				<div class="dropdown dropdown-top">
					<button class="btn btn-ghost btn-xs btn-circle" type="button" title="Message stats" aria-label="Message stats">
						<svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<circle cx="12" cy="12" r="10"></circle>
							<path d="M12 16v-4"></path>
							<path d="M12 8h.01"></path>
						</svg>
					</button>
					<div class="dropdown-content z-20 mt-2 w-72 rounded-xl border border-base-300 bg-base-100 p-3 text-xs shadow-xl">
						<div class="grid grid-cols-2 gap-x-3 gap-y-2">
							<span class="opacity-70">Model</span>
							<span class="truncate text-right">{message.model ?? 'n/a'}</span>
							<span class="opacity-70">Tokens In</span>
							<span class="text-right">{estimatedTokensIn}</span>
							<span class="opacity-70">Tokens Out</span>
							<span class="text-right">{estimatedTokensOut}</span>
							<span class="opacity-70">Cost</span>
							<span class="text-right">${formattedCost}</span>
							<span class="opacity-70">TTFT</span>
							<span class="text-right">{message.ttftMs ?? 'n/a'}{message.ttftMs !== null ? 'ms' : ''}</span>
							<span class="opacity-70">Total</span>
							<span class="text-right">{message.totalMs ?? 'n/a'}{message.totalMs !== null ? 'ms' : ''}</span>
							<span class="opacity-70">Tok/s</span>
							<span class="text-right">{message.tokensPerSec ?? 'n/a'}</span>
						</div>
					</div>
				</div>
			{/if}
		</div>
	{/if}

	{#if messageArtifacts.length > 0}
		<div class="mt-2 w-full space-y-1">
			{#each messageArtifacts as artifact (artifact.id)}
				<ArtifactPreviewCard {artifact} onOpen={onOpenArtifact} />
			{/each}
		</div>
	{/if}
</article>

<style>
	:global(.markdown-body) {
		line-height: 1.65;
		word-break: break-word;
	}

	:global(.markdown-body h1),
	:global(.markdown-body h2),
	:global(.markdown-body h3),
	:global(.markdown-body h4) {
		margin: 1rem 0 0.6rem;
		font-weight: 650;
		line-height: 1.25;
	}

	:global(.markdown-body p) {
		margin: 0.65rem 0;
	}

	:global(.markdown-body ul) {
		margin: 0.65rem 0;
		padding-left: 1.25rem;
		list-style-type: disc;
	}

	:global(.markdown-body ol) {
		margin: 0.65rem 0;
		padding-left: 1.25rem;
		list-style-type: decimal;
	}

	:global(.markdown-body li + li) {
		margin-top: 0.3rem;
	}

	:global(.markdown-body blockquote) {
		margin: 0.8rem 0;
		border-left: 3px solid color-mix(in oklab, var(--color-primary) 45%, var(--color-base-300));
		padding-left: 0.85rem;
		opacity: 0.95;
	}

	:global(.markdown-body a) {
		text-decoration: underline;
		text-underline-offset: 2px;
		color: color-mix(in oklab, var(--color-primary) 72%, var(--color-base-content));
	}

	:global(.markdown-body code) {
		border: 1px solid var(--color-base-300);
		border-radius: 0.45rem;
		padding: 0.15rem 0.4rem;
		font-family: 'Cascadia Code', 'Consolas', monospace;
		font-size: 0.86em;
		background: color-mix(in oklab, var(--color-base-200) 75%, white 5%);
	}

	:global(.markdown-body pre) {
		margin: 0.9rem 0;
		overflow-x: auto;
		border: 1px solid color-mix(in oklab, var(--color-base-300) 88%, var(--color-primary));
		border-radius: 0.9rem;
		padding: 0.9rem 1rem;
		background: linear-gradient(
			180deg,
			color-mix(in oklab, var(--color-base-200) 86%, white 4%),
			color-mix(in oklab, var(--color-base-100) 95%, var(--color-base-300) 4%)
		);
	}

	:global(.markdown-body pre code) {
		padding: 0;
		border: 0;
		background: transparent;
	}

	:global(.markdown-body table) {
		display: block;
		overflow-x: auto;
		width: 100%;
		border-collapse: collapse;
		margin: 0.75rem 0;
	}

	:global(.markdown-body th),
	:global(.markdown-body td) {
		border: 1px solid var(--color-base-300);
		padding: 0.4rem 0.55rem;
	}

	:global(.markdown-body .hljs-keyword),
	:global(.markdown-body .hljs-selector-tag),
	:global(.markdown-body .hljs-literal),
	:global(.markdown-body .hljs-doctag) {
		color: oklch(45% 0.15 280);
	}

	:global(.markdown-body .hljs-string),
	:global(.markdown-body .hljs-attr),
	:global(.markdown-body .hljs-template-tag) {
		color: oklch(48% 0.18 145);
	}

	:global(.markdown-body .hljs-comment),
	:global(.markdown-body .hljs-quote) {
		color: color-mix(in oklab, var(--color-base-content) 42%, var(--color-base-300));
		font-style: italic;
	}

	:global(.markdown-body .hljs-number),
	:global(.markdown-body .hljs-symbol),
	:global(.markdown-body .hljs-bullet) {
		color: oklch(52% 0.2 45);
	}

	:global(.markdown-body .hljs-title),
	:global(.markdown-body .hljs-function) {
		color: oklch(40% 0.16 250);
	}
</style>


