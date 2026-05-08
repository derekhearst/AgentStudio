<script lang="ts">
	import type { getAgent } from '$lib/agents'
	import { formatCost, formatTokens, relativeTime } from './agent-format'

	type AgentData = NonNullable<Awaited<ReturnType<typeof getAgent>>>

	let { stats, lastActiveAt = null } = $props<{
		stats: AgentData['stats']
		lastActiveAt?: Date | string | null
	}>()
</script>

<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
	<!-- Sessions -->
	<div class="card card-body bg-base-100 border-base-300 rounded-2xl border p-4">
		<div class="mb-2 flex h-8 w-8 items-center justify-center rounded-xl bg-primary/15 text-primary">
			<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
			</svg>
		</div>
		<p class="text-2xl font-bold tabular-nums">{stats.sessionCount}</p>
		<p class="mt-0.5 text-xs text-base-content/50">Sessions</p>
	</div>

	<!-- Total cost -->
	<div class="card card-body bg-base-100 border-base-300 rounded-2xl border p-4">
		<div class="mb-2 flex h-8 w-8 items-center justify-center rounded-xl bg-success/15 text-success">
			<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<circle cx="12" cy="12" r="10"/><path d="M12 6v12M9 9h4.5a1.5 1.5 0 0 1 0 3H9m0 3h4.5a1.5 1.5 0 0 1 0 3H9"/>
			</svg>
		</div>
		<p class="text-2xl font-bold tabular-nums">{formatCost(stats.totalCost)}</p>
		<p class="mt-0.5 text-xs text-base-content/50">Total cost</p>
	</div>

	<!-- Total tokens -->
	<div class="card card-body bg-base-100 border-base-300 rounded-2xl border p-4">
		<div class="mb-2 flex h-8 w-8 items-center justify-center rounded-xl bg-info/15 text-info">
			<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
			</svg>
		</div>
		<p class="text-2xl font-bold tabular-nums">{formatTokens(stats.totalTokens)}</p>
		<p class="mt-0.5 text-xs text-base-content/50">Tokens</p>
	</div>

	<!-- Avg cost/session -->
	<div class="card card-body bg-base-100 border-base-300 rounded-2xl border p-4">
		<div class="mb-2 flex h-8 w-8 items-center justify-center rounded-xl bg-warning/15 text-warning">
			<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
			</svg>
		</div>
		<p class="text-2xl font-bold tabular-nums">{formatCost(stats.avgCostPerSession)}</p>
		<p class="mt-0.5 text-xs text-base-content/50">Avg/session</p>
	</div>

	<!-- Avg first token -->
	<div class="card card-body bg-base-100 border-base-300 rounded-2xl border p-4">
		<div class="mb-2 flex h-8 w-8 items-center justify-center rounded-xl bg-secondary/15 text-secondary">
			<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
			</svg>
		</div>
		<p class="text-2xl font-bold tabular-nums">
			{stats.avgTtftMs !== null ? `${stats.avgTtftMs}ms` : '—'}
		</p>
		<p class="mt-0.5 text-xs text-base-content/50">Avg first token</p>
	</div>

	<!-- Last active -->
	<div class="card card-body bg-base-100 border-base-300 rounded-2xl border p-4">
		<div class="mb-2 flex h-8 w-8 items-center justify-center rounded-xl bg-accent/15 text-accent">
			<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
			</svg>
		</div>
		<p class="truncate text-xl font-bold">{relativeTime(lastActiveAt)}</p>
		<p class="mt-0.5 text-xs text-base-content/50">Last active</p>
	</div>
</div>
