<script lang="ts">
	import { renderMarkdown } from '$lib/chat/chat';
	import ArtifactCard from './ArtifactCard.svelte';
	import SubagentBlockCard from './SubagentBlockCard.svelte';
	import ThinkingBlockCard from './ThinkingBlockCard.svelte';
	import ToolCallCard from './ToolCallCard.svelte';
	import {
		askQuestionAlreadyInMessage,
		blockHasRenderableOutput,
		getArtifactCardProps,
		getAskUserAnswer,
		getAskUserQuestions,
		type SavedBlock,
	} from './message-bubble-helpers';

	/**
	 * Renders the per-block dispatch for a persisted assistant message — the
	 * `metadata.blocks` array we round-trip through the DB. Pulled out of
	 * `MessageBubble.svelte` so the bubble can be a thin layout shell.
	 *
	 * Block-kind dispatch:
	 *   - tool/ask_user        → inline question + (if available) the answer bubble
	 *   - tool/present_artifact → ArtifactCard, or ToolCallCard fallback if no card data
	 *   - tool (other)          → ToolCallCard
	 *   - thinking              → ThinkingBlockCard
	 *   - subagent              → SubagentBlockCard
	 *   - text                  → rendered markdown
	 *
	 * `messageId` is used to compose stable per-block keys; `messageContent` is
	 * the raw assistant text (used to suppress redundant ask_user prompts that
	 * already appear in the message body).
	 */

	let {
		messageId,
		messageContent,
		blocks,
		messageReasoningTokens = null,
	}: {
		messageId: string;
		messageContent: string;
		blocks: SavedBlock[];
		messageReasoningTokens?: number | null;
	} = $props();

	// The most-recent thinking block gets the message-level reasoning-token count
	// stamped onto it (the loop only learns the count from the LAST chunk; we
	// backfill the latest persisted thinking block with that final number).
	const lastThinkingBlockIndex = $derived(
		blocks.reduce((latest, block, index) => (block.kind === 'thinking' ? index : latest), -1),
	);

	const askQuestionAlreadyHere = (question: string | undefined) =>
		askQuestionAlreadyInMessage(question, blocks, messageContent);
</script>

{#each blocks as block, idx (`${messageId}-block-${idx}`)}
	{#if block.kind === 'tool' && block.name === 'ask_user'}
		{@const askQuestions = getAskUserQuestions(block.arguments, block.result)}
		{#if askQuestions.length > 0}
			{#each askQuestions as q}
				{#if !askQuestionAlreadyHere(q.question ?? q.header)}
					<div class="assistant-message mb-2">
						<div class="markdown-body">{@html renderMarkdown(q.question ?? q.header)}</div>
					</div>
				{/if}
				{@const answer = getAskUserAnswer(block.result, q.header)}
				{#if answer}
					<div class="mb-2 ml-auto w-fit max-w-[85%]">
						<div class="user-bubble bg-base-200/80 text-base-content rounded-2xl px-4 py-2.5 shadow-sm">
							<p class="whitespace-pre-wrap">{answer}</p>
						</div>
					</div>
				{/if}
			{/each}
		{/if}
	{:else if block.kind === 'tool' && block.name === 'present_artifact'}
		{@const card = getArtifactCardProps(block.result)}
		{#if card}
			<div class="mb-1.5 w-full">
				<ArtifactCard {...card} />
			</div>
		{:else}
			<div class="mb-1.5 w-full">
				<ToolCallCard
					name={String(block.name)}
					argumentsText={JSON.stringify(block.arguments ?? {}, null, 2)}
					result={typeof block.result === 'string' ? block.result : JSON.stringify(block.result ?? {}, null, 2)}
					status={block.success === false ? 'failed' : 'completed'}
				/>
			</div>
		{/if}
	{:else if block.kind === 'tool' && block.name !== 'ask_user'}
		<div class="mb-1.5 w-full">
			<ToolCallCard
				name={String(block.name)}
				argumentsText={JSON.stringify(block.arguments ?? {}, null, 2)}
				result={typeof block.result === 'string' ? block.result : JSON.stringify(block.result ?? {}, null, 2)}
				status={block.success === false ? 'failed' : 'completed'}
			/>
		</div>
	{:else if block.kind === 'thinking' && block.content?.trim()}
		<div class="mb-1.5 w-full">
			<ThinkingBlockCard
				content={block.content}
				reasoningTokens={idx === lastThinkingBlockIndex ? messageReasoningTokens : block.reasoningTokens ?? null}
				expanded={true}
			/>
		</div>
	{:else if block.kind === 'subagent' && blockHasRenderableOutput(block)}
		<div class="mb-1.5 w-full">
			<SubagentBlockCard
				agentName={block.agentName}
				agentId={block.agentId}
				conversationId={block.conversationId}
				task={block.task}
				content={block.content}
				status={block.success ? 'completed' : 'failed'}
				expanded={false}
			/>
		</div>
	{:else if block.kind === 'text' && block.content?.trim()}
		<div class="assistant-message mb-2">
			<div class="markdown-body">{@html renderMarkdown(block.content)}</div>
		</div>
	{/if}
{/each}
