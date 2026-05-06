<script lang="ts">
	import { renderMarkdown } from './chat';

	let {
		agentName,
		agentId,
		conversationId = null,
		task,
		content = '',
		status = 'running',
		toolCalls = [],
		expanded = true,
	} = $props<{
		agentName: string;
		agentId: string;
		conversationId?: string | null;
		task: string;
		content?: string;
		status?: 'running' | 'completed' | 'failed';
		toolCalls?: Array<{ name: string; success?: boolean }>;
		expanded?: boolean;
	}>();

	const isRunning = $derived(status === 'running');
	const isCompleted = $derived(status === 'completed');
	const isFailed = $derived(status === 'failed');

	const accentClass = $derived(
		isFailed ? 'border-l-2 border-error/60 pl-1.5' : isRunning ? 'border-l-2 border-primary/50 pl-1.5' : '',
	);

	const completedTools = $derived(toolCalls.filter((t: { name: string; success?: boolean }) => t.success !== undefined).length);
</script>

<details class={`collapse collapse-arrow subagent-block rounded-md ${accentClass}`} open={expanded}>
	<summary class="collapse-title flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm font-normal min-h-0 select-none rounded-md transition-colors hover:bg-base-200/50">
		<div class="flex min-w-0 flex-1 items-center gap-2">
			{#if isRunning}
				<svg class="h-3.5 w-3.5 shrink-0 animate-spin text-primary/80" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
					<path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round" />
				</svg>
			{:else if isFailed}
				<svg class="h-3.5 w-3.5 shrink-0 text-error/80" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<circle cx="12" cy="12" r="10" />
					<line x1="12" y1="7" x2="12" y2="13" />
					<circle cx="12" cy="17" r="0.5" fill="currentColor" />
				</svg>
			{:else}
				<svg class="h-3.5 w-3.5 shrink-0 text-base-content/45" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<polyline points="20 6 9 17 4 12" />
				</svg>
			{/if}

			<span class="truncate">
				<span class="font-medium text-base-content/85">{agentName}</span>
				{#if isRunning}
					<span class="text-base-content/55">working…</span>
				{:else if isFailed}
					<span class="text-error/75">failed</span>
				{:else}
					<span class="text-base-content/45">done</span>
				{/if}
			</span>

			{#if completedTools > 0}
				<span class="text-[11px] text-base-content/45">· {completedTools} tool{completedTools === 1 ? '' : 's'}</span>
			{/if}
		</div>
	</summary>

	<div class="collapse-content space-y-2 px-2 pb-2 text-sm">
		<p class="text-xs text-base-content/55 italic">{task}</p>

		{#if toolCalls.length > 0}
			<div class="flex flex-wrap gap-1">
				{#each toolCalls as tc}
					<span
						class="badge badge-sm badge-ghost"
						class:badge-success={tc.success === true}
						class:badge-error={tc.success === false}
					>
						{tc.name}
					</span>
				{/each}
			</div>
		{/if}

		{#if content}
			<div class="max-h-48 overflow-y-auto rounded-md bg-base-200/40 px-3 py-2 text-sm">
				<div class="markdown-body">{@html renderMarkdown(content.slice(0, 2000))}</div>
			</div>
		{/if}

		{#if isCompleted && conversationId}
			<a href="/chat/{conversationId}" class="link link-primary text-xs">
				View full conversation →
			</a>
		{/if}
	</div>
</details>
