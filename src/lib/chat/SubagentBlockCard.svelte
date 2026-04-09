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

	const colorClass = $derived(
		isFailed
			? 'border-error/50 bg-error/5'
			: isRunning
				? 'border-primary/50 bg-primary/5'
				: 'border-success/50 bg-success/5',
	);

	const completedTools = $derived(toolCalls.filter((t: { name: string; success?: boolean }) => t.success !== undefined).length);
</script>

<details class={`subagent-block rounded-xl border ${colorClass} transition-all duration-300`} open={expanded}>
	<summary class="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium select-none">
		<div class="flex min-w-0 flex-1 items-center gap-2">
			{#if isRunning}
				<svg class="h-4 w-4 shrink-0 animate-spin text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
					<path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round" />
				</svg>
			{:else if isFailed}
				<svg class="h-4 w-4 shrink-0 text-error" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<circle cx="12" cy="12" r="10" />
					<line x1="12" y1="7" x2="12" y2="13" />
					<circle cx="12" cy="17" r="0.5" fill="currentColor" />
				</svg>
			{:else}
				<svg class="h-4 w-4 shrink-0 text-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<circle cx="12" cy="12" r="10" />
					<path d="M8 12l3 3 5-5" />
				</svg>
			{/if}

			<span class="truncate">
				<span class="font-semibold">{agentName}</span>
				{#if isRunning}
					<span class="text-base-content/60">working…</span>
				{:else if isFailed}
					<span class="text-error/80">failed</span>
				{:else}
					<span class="text-success/80">done</span>
				{/if}
			</span>

			{#if completedTools > 0}
				<span class="badge badge-ghost badge-xs">{completedTools} tool{completedTools === 1 ? '' : 's'}</span>
			{/if}
		</div>

		<svg
			class="h-4 w-4 shrink-0 transition-transform duration-200"
			class:rotate-180={expanded}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
		>
			<path d="m6 9 6 6 6-6" />
		</svg>
	</summary>

	<div class="space-y-2 px-3 pb-3">
		<p class="text-xs text-base-content/50 italic">{task}</p>

		{#if toolCalls.length > 0}
			<div class="flex flex-wrap gap-1">
				{#each toolCalls as tc}
					<span
						class="badge badge-sm"
						class:badge-success={tc.success === true}
						class:badge-error={tc.success === false}
						class:badge-ghost={tc.success === undefined}
					>
						{tc.name}
					</span>
				{/each}
			</div>
		{/if}

		{#if content}
			<div class="max-h-48 overflow-y-auto rounded-lg border border-base-300/40 bg-base-200/30 px-3 py-2 text-sm">
				<div class="markdown-body">{@html renderMarkdown(content.slice(0, 2000))}</div>
			</div>
		{/if}

		{#if isCompleted && conversationId}
			<a
				href="/chat/{conversationId}"
				class="link link-primary text-xs"
			>
				View full conversation →
			</a>
		{/if}
	</div>
</details>
