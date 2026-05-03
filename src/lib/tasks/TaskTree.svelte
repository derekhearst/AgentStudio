<script lang="ts">
	type TaskNode = {
		id: string
		title: string
		status: string
		priority: number
		budgetUsd: string | null
		depth: number
	}

	let {
		nodes,
		highlightTaskId = null,
	} = $props<{
		nodes: TaskNode[]
		highlightTaskId?: string | null
	}>()

	function statusTone(s: string): string {
		switch (s) {
			case 'pending':
				return 'badge-ghost'
			case 'planning':
				return 'badge-info'
			case 'awaiting_approval':
				return 'badge-warning'
			case 'running':
				return 'badge-primary'
			case 'blocked':
			case 'failed':
				return 'badge-error'
			case 'completed':
				return 'badge-success'
			case 'canceled':
				return 'badge-ghost'
			default:
				return 'badge-ghost'
		}
	}

	function fmtCost(usd: string | null) {
		if (!usd) return ''
		const n = parseFloat(usd)
		if (Number.isNaN(n)) return ''
		return n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`
	}
</script>

<ul class="space-y-1 text-sm">
	{#each nodes as node, idx (node.id)}
		{@const isHighlight = node.id === highlightTaskId}
		{@const indentPx = node.depth * 18}
		<li>
			<a
				href="/tasks/{node.id}"
				class="flex items-center gap-2 rounded-xl border border-base-300/60 bg-base-100 px-3 py-2 transition-colors hover:border-base-content/30 {isHighlight ? 'ring-2 ring-info/40' : ''}"
				style="margin-left: {indentPx}px"
				title={node.title}
			>
				{#if node.depth > 0}
					<svg class="size-3 shrink-0 opacity-40" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5">
						<path d="M3 1v8h6" stroke-linecap="round" stroke-linejoin="round" />
					</svg>
				{/if}
				<span class="line-clamp-1 flex-1 font-medium leading-tight">{node.title}</span>
				{#if node.priority > 0}
					<span class="badge badge-xs badge-ghost">P{node.priority}</span>
				{/if}
				{#if node.budgetUsd}
					<span class="font-mono text-xs tabular-nums opacity-60">{fmtCost(node.budgetUsd)}</span>
				{/if}
				<span class="badge badge-xs {statusTone(node.status)}">{node.status}</span>
			</a>
		</li>
	{/each}
</ul>
