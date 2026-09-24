<script lang="ts">
	import { renderMarkdown } from './chat';
	import type { SubagentDetails } from '$lib/engine/tool-result-details';
	import type { SubagentTranscriptEntry } from '$lib/engine/subagent-transcript';
	import {
		subagentCardEntries,
		subagentCardStats,
		subagentStatusLabel,
		type SubagentCardStatus,
	} from './subagent-card';

	/**
	 * One delegated child (#32): a collapsed card with the agent, how it ended, its tokens,
	 * cost and duration, that expands to the child's own transcript — what it said and which
	 * tools it called, in order. Used for the live stream and for a persisted message alike;
	 * the fields past `expanded` are absent on blocks persisted before #32, and the card falls
	 * back to the text and call names those carried.
	 */
	let {
		agentName,
		agentId,
		conversationId = null,
		task,
		content = '',
		status = 'running',
		toolCalls = [],
		expanded = false,
		transcript = [],
		transcriptTruncated = false,
		details = undefined,
		error = null,
		costUsd = null,
	} = $props<{
		agentName: string;
		agentId: string;
		conversationId?: string | null;
		task: string;
		content?: string;
		status?: SubagentCardStatus;
		toolCalls?: Array<{ name: string; success?: boolean }>;
		expanded?: boolean;
		transcript?: SubagentTranscriptEntry[];
		transcriptTruncated?: boolean;
		details?: SubagentDetails;
		error?: string | null;
		costUsd?: number | null;
	}>();

	const isRunning = $derived(status === 'running');
	const isCompleted = $derived(status === 'completed');
	const isProblem = $derived(status === 'failed' || status === 'stopped');

	const statusLabel = $derived(subagentStatusLabel(status, error));
	const entries = $derived(subagentCardEntries({ transcript, content, toolCalls, details }));
	const stats = $derived(subagentCardStats({ details, costUsd, transcript: entries }));

	const accentClass = $derived(
		isProblem ? 'border-l-2 border-error/60 pl-1.5' : isRunning ? 'border-l-2 border-primary/50 pl-1.5' : '',
	);
</script>

<details
	class={`collapse collapse-arrow subagent-block rounded-md ${accentClass}`}
	open={expanded}
	data-testid="subagent-card"
	data-status={status}
	data-agent-id={agentId}
>
	<summary
		class="collapse-title flex min-h-0 cursor-pointer select-none items-start gap-2 rounded-md px-2 py-1.5 pr-8 text-sm font-normal transition-colors hover:bg-base-200/50"
	>
		<span class="mt-0.5 shrink-0">
			{#if isRunning}
				<svg class="h-3.5 w-3.5 animate-spin text-primary/80" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
					<path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round" />
				</svg>
			{:else if isProblem}
				<svg class="h-3.5 w-3.5 text-error/80" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<circle cx="12" cy="12" r="10" />
					<line x1="12" y1="7" x2="12" y2="13" />
					<circle cx="12" cy="17" r="0.5" fill="currentColor" />
				</svg>
			{:else}
				<svg class="h-3.5 w-3.5 text-base-content/45" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<polyline points="20 6 9 17 4 12" />
				</svg>
			{/if}
		</span>

		<span class="block min-w-0 flex-1">
			<span class="flex min-w-0 items-baseline gap-2">
				<span class="min-w-0 truncate font-medium text-base-content/85" data-testid="subagent-card-name">{agentName}</span>
				<span
					class={`shrink-0 text-xs ${isProblem ? 'text-error/80' : 'text-base-content/55'}`}
					data-testid="subagent-card-status">{statusLabel}</span
				>
			</span>
			{#if task}
				<span class="block truncate text-xs text-base-content/55" data-testid="subagent-card-task">{task}</span>
			{/if}
			{#if stats.length > 0}
				<span class="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-base-content/45" data-testid="subagent-card-stats">
					{#each stats as stat, i}
						<span>{#if i > 0}<span aria-hidden="true" class="mr-2">·</span>{/if}{stat}</span>
					{/each}
				</span>
			{/if}
		</span>
	</summary>

	<div class="collapse-content space-y-2 px-2 pb-2 text-sm" data-testid="subagent-card-transcript">
		{#if error && !isCompleted}
			<p class="rounded-md bg-error/10 px-2 py-1 text-xs text-error/85 break-words">{error}</p>
		{/if}

		{#if entries.length > 0}
			<ol class="max-h-96 space-y-1.5 overflow-y-auto rounded-md bg-base-200/40 px-3 py-2">
				{#each entries as entry, idx (idx)}
					{#if entry.kind === 'text'}
						{#if entry.text.trim()}
							<li class="markdown-body text-sm">{@html renderMarkdown(entry.text)}</li>
						{/if}
					{:else}
						<li class="flex min-w-0 items-center gap-1.5 text-xs text-base-content/65" data-testid="subagent-card-tool">
							<span
								class={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
									entry.success === true ? 'bg-success' : entry.success === false ? 'bg-error' : 'bg-base-content/40'
								}`}
								aria-hidden="true"
							></span>
							<span class="shrink-0 font-mono">{entry.name}</span>
							{#if entry.label}
								<span class="min-w-0 truncate text-base-content/50">{entry.label}</span>
							{/if}
						</li>
					{/if}
				{/each}
			</ol>
		{:else if isRunning}
			<p class="text-xs italic text-base-content/50">Starting…</p>
		{/if}

		{#if transcriptTruncated || details?.reportTruncated}
			<p class="text-[11px] text-base-content/45">The transcript was shortened to keep this conversation small.</p>
		{/if}

		{#if isCompleted && conversationId}
			<a href="/chat/{conversationId}" class="link link-primary text-xs">View full conversation →</a>
		{/if}
	</div>
</details>
