<script lang="ts">
	type StreamingBlock = {
		kind: 'thinking' | 'text' | 'tool' | 'subagent'
		[key: string]: unknown
	}

	let {
		// `conversationId` is no longer used inside the component — the Trace link now points at
		// /runs/[runId]. Kept on the prop signature so existing callers don't break.
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		streaming = false,
		conversationId: _conversationId,
		runId = null,
		mode = 'chat',
		streamingBlocks = [] as StreamingBlock[],
		pendingApprovalCount = 0,
		pendingQuestion = false,
		tokenEstimate = 0,
		contextWindow = 0,
		didCompact = false,
		onCancel,
		onAnswerQuestion,
	}: {
		streaming?: boolean
		conversationId: string
		runId?: string | null
		mode?: 'chat' | 'research' | 'plan' | 'agent'
		streamingBlocks?: StreamingBlock[]
		pendingApprovalCount?: number
		pendingQuestion?: boolean
		tokenEstimate?: number
		contextWindow?: number
		didCompact?: boolean
		onCancel?: (() => void) | undefined
		onAnswerQuestion?: (() => void) | undefined
	} = $props()

	const subagentCount = $derived(streamingBlocks.filter((b) => b.kind === 'subagent').length)
	const toolCalls = $derived(streamingBlocks.filter((b) => b.kind === 'tool'))

	const currentToolName = $derived.by(() => {
		// Most recent tool block that's still in progress (no result yet) or the last completed one.
		const inFlight = [...toolCalls].reverse().find((b) => {
			const result = (b as { result?: unknown }).result
			return result === undefined || result === null
		})
		const last = toolCalls[toolCalls.length - 1]
		const target = (inFlight ?? last) as { name?: string } | undefined
		return target?.name ?? null
	})

	const tokenPct = $derived(
		contextWindow > 0 ? Math.min(100, Math.round((tokenEstimate / contextWindow) * 100)) : 0,
	)

	const visible = $derived(streaming || pendingQuestion || pendingApprovalCount > 0)

	const statusLabel = $derived.by(() => {
		if (pendingQuestion) return 'Waiting for your answer'
		if (pendingApprovalCount > 0)
			return `Waiting for ${pendingApprovalCount} approval${pendingApprovalCount === 1 ? '' : 's'}`
		if (currentToolName) return `Running ${currentToolName}`
		if (streaming) return 'Generating'
		return 'Idle'
	})

	const statusColor = $derived.by(() => {
		if (pendingQuestion || pendingApprovalCount > 0) return 'badge-warning'
		if (currentToolName) return 'badge-info'
		if (streaming) return 'badge-primary'
		return 'badge-ghost'
	})
</script>

{#if visible}
	<div class="run-hud mb-2 card card-body bg-base-100/95 border-base-300 rounded-2xl border px-3 py-2 text-sm shadow-sm">
		<div class="flex items-center gap-2">
			<span class="badge badge-sm {statusColor}">{statusLabel}</span>
			{#if mode !== 'chat'}
				<span class="badge badge-sm badge-outline capitalize">{mode}</span>
			{/if}

			<div class="flex-1 truncate text-xs text-base-content/70">
				{#if toolCalls.length > 0}
					<span>{toolCalls.length} tool call{toolCalls.length === 1 ? '' : 's'}</span>
				{/if}
				{#if subagentCount > 0}
					<span class="ml-2">· {subagentCount} sub-agent{subagentCount === 1 ? '' : 's'}</span>
				{/if}
				{#if didCompact}
					<span class="ml-2">· compacted</span>
				{/if}
			</div>

			{#if tokenEstimate > 0 && contextWindow > 0}
				<span
					class="font-mono text-xs tabular-nums text-base-content/70"
					title={`${tokenEstimate.toLocaleString()} / ${contextWindow.toLocaleString()} tokens`}
				>
					{tokenPct}%
				</span>
			{/if}

			{#if pendingQuestion && onAnswerQuestion}
				<button class="btn btn-warning btn-xs" type="button" onclick={() => onAnswerQuestion?.()}>
					Answer
				</button>
			{/if}

			{#if streaming && onCancel}
				<button class="btn btn-ghost btn-xs" type="button" onclick={() => onCancel?.()}>
					Cancel
				</button>
			{/if}

			{#if runId}
				<a class="btn btn-ghost btn-xs" href={`/runs/${runId}`} title={`Run ${runId.slice(0, 8)} — open the event timeline`}>
					Trace ↗
				</a>
			{/if}
		</div>
	</div>
{/if}
