<script lang="ts">
	import { listAutomationRunsQuery, listAutomationsQuery } from '$lib/automations'
	import { describeRunTrigger, formatDate, relativeTime } from './automation-format'

	type AutomationRow = Awaited<ReturnType<typeof listAutomationsQuery>>[number]
	type AutomationRunRow = Awaited<ReturnType<typeof listAutomationRunsQuery>>[number]

	let {
		automation,
		toggling = false,
		deleting = false,
		running = false,
		onDuplicate,
		onToggle,
		onDelete,
		onRunNow,
	} = $props<{
		automation: AutomationRow
		toggling?: boolean
		deleting?: boolean
		running?: boolean
		onDuplicate: (automation: AutomationRow) => void
		onToggle: (automation: AutomationRow) => void
		onDelete: (automation: AutomationRow) => void
		onRunNow: (automation: AutomationRow) => void
	}>()

	const rowBusy = $derived(toggling || deleting)

	// #31 — the system switching an automation off is a bug report, not a preference.
	// It must not render the same as a switch the user flipped.
	const autoDisabled = $derived(!automation.enabled && automation.disabledReason === 'consecutive_failures')
	const lastRunFailed = $derived(automation.lastRunStatus === 'failed')

	let historyOpen = $state(false)
	let historyLoading = $state(false)
	let historyError = $state<string | null>(null)
	let runs = $state<AutomationRunRow[]>([])

	async function loadHistory(force = false) {
		historyLoading = true
		historyError = null
		try {
			const call = listAutomationRunsQuery({ automationId: automation.id, limit: 10 })
			if (force) await call.refresh()
			runs = await call
		} catch {
			historyError = 'Could not load run history.'
		} finally {
			historyLoading = false
		}
	}

	async function toggleHistory() {
		historyOpen = !historyOpen
		if (historyOpen && runs.length === 0) await loadHistory()
	}

	function statusBadgeClass(status: string | null) {
		if (status === 'completed') return 'badge-success'
		if (status === 'failed') return 'badge-error'
		if (status === 'blocked') return 'badge-warning'
		if (status === 'running') return 'badge-info'
		return 'badge-ghost'
	}

	function formatDuration(ms: number | null) {
		if (ms === null || ms === undefined) return '—'
		if (ms < 1000) return `${ms}ms`
		if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
		return `${Math.round(ms / 60_000)}m`
	}

	function formatCost(value: string | null) {
		if (!value) return null
		const parsed = Number.parseFloat(value)
		if (!Number.isFinite(parsed) || parsed <= 0) return null
		return parsed < 0.01 ? `$${parsed.toFixed(4)}` : `$${parsed.toFixed(2)}`
	}

	function runLink(run: AutomationRunRow): { href: string; label: string } | null {
		if (run.researchId) return { href: `/research/${run.researchId}`, label: 'Research' }
		if (run.conversationId) return { href: `/chat/${run.conversationId}`, label: 'Conversation' }
		return null
	}
</script>

<article
	class="group relative overflow-hidden rounded-2xl border border-base-300 bg-base-100 transition-all duration-200 hover:border-base-content/20 hover:shadow-xl hover:shadow-base-content/5"
>
	<div
		class="relative h-0.75 w-full overflow-hidden {automation.enabled
			? 'bg-success/30'
			: autoDisabled
				? 'bg-error/50'
				: 'bg-base-300/60'}"
	>
		{#if automation.enabled}
			<div class="shimmer-bar absolute inset-y-0 w-1/2 bg-linear-to-r from-transparent via-success to-transparent"></div>
		{/if}
	</div>

	<div class="space-y-3 p-4">
		<div class="flex flex-wrap items-start justify-between gap-2">
			<div class="min-w-0 flex-1">
				<h2 class="truncate font-semibold leading-snug">{automation.description}</h2>
				<p class="truncate text-xs text-base-content/55">
					Agent: {automation.agentName ?? 'Orchestrator'}
					<span class="mx-1">•</span>
					{automation.conversationMode === 'new_each_run' ? 'New conversation' : 'Reuse conversation'}
				</p>
			</div>
			<div class="flex flex-wrap items-center justify-end gap-1">
				{#if automation.lastRunStatus}
					<span
						class="badge badge-sm {statusBadgeClass(automation.lastRunStatus)}"
						title="Most recent run ({describeRunTrigger(automation.lastRunTrigger)})"
					>
						{automation.lastRunStatus}
					</span>
				{/if}
				{#if autoDisabled}
					<span class="badge badge-sm badge-error" title="Switched off automatically after repeated failures">
						auto-disabled
					</span>
				{:else}
					<span class="badge badge-sm {automation.enabled ? 'badge-success' : 'badge-ghost'}">
						{automation.enabled ? 'enabled' : 'disabled'}
					</span>
				{/if}
			</div>
		</div>

		{#if autoDisabled || lastRunFailed || automation.consecutiveFailures > 0}
			<div
				class="rounded-xl border px-3 py-2 text-xs {autoDisabled
					? 'border-error/40 bg-error/10 text-error'
					: 'border-warning/40 bg-warning/10 text-warning'}"
			>
				<p class="font-semibold">
					{#if autoDisabled}
						Switched off after {automation.consecutiveFailures} consecutive failures
					{:else if automation.consecutiveFailures > 0}
						{automation.consecutiveFailures} consecutive failed run{automation.consecutiveFailures === 1 ? '' : 's'}
					{:else}
						Last run failed
					{/if}
					{#if automation.failures24h > 0}
						<span class="font-normal opacity-80">• {automation.failures24h} failed run(s) in 24h</span>
					{/if}
				</p>
				{#if automation.lastRunError}
					<p class="mt-1 line-clamp-2 font-mono text-[11px] opacity-80">{automation.lastRunError}</p>
				{/if}
				{#if autoDisabled}
					<p class="mt-1 opacity-80">Fix the cause, use Run now to verify, then Enable to resume the schedule.</p>
				{/if}
			</div>
		{/if}

		<div class="rounded-xl border border-base-300/60 bg-base-200/20 p-3">
			<p class="text-[10px] font-semibold uppercase tracking-wide text-base-content/35">Prompt</p>
			<p class="mt-1 line-clamp-3 text-sm text-base-content/70">{automation.prompt}</p>
		</div>

		<div class="grid gap-2 text-xs text-base-content/60 sm:grid-cols-2">
			<div class="rounded-lg border border-base-300/60 bg-base-200/20 px-3 py-2">
				<p class="text-[10px] uppercase tracking-wide text-base-content/35">Cron</p>
				<p class="mt-0.5 font-mono text-[11px]">{automation.cronExpression}</p>
				<!-- #30 — the expression is wall-clock, so the zone is half the schedule. -->
				<p class="mt-0.5 truncate text-[10px] text-base-content/45" title="Schedule time zone">
					{automation.timezone ?? 'America/Boise'}
				</p>
			</div>
			<div class="rounded-lg border border-base-300/60 bg-base-200/20 px-3 py-2">
				<p class="text-[10px] uppercase tracking-wide text-base-content/35">Last run</p>
				<p class="mt-0.5">{relativeTime(automation.lastRunAt)}</p>
			</div>
			<div class="rounded-lg border border-base-300/60 bg-base-200/20 px-3 py-2">
				<p class="text-[10px] uppercase tracking-wide text-base-content/35">Next run</p>
				<p class="mt-0.5">{formatDate(automation.nextRunAt)}</p>
			</div>
			<div class="rounded-lg border border-base-300/60 bg-base-200/20 px-3 py-2">
				<p class="text-[10px] uppercase tracking-wide text-base-content/35">Updated</p>
				<p class="mt-0.5">{relativeTime(automation.updatedAt)}</p>
			</div>
		</div>

		<div class="flex flex-wrap items-center gap-2">
			<!-- #31 — on-demand execution. Queued as a job; the schedule is left alone. -->
			<button
				class="btn btn-xs btn-primary"
				disabled={rowBusy || running}
				onclick={() => onRunNow(automation)}
				title="Run this automation once now — does not change the next scheduled run"
			>
				{#if running}
					<span class="loading loading-spinner loading-xs"></span>
					Queuing
				{:else}
					Run now
				{/if}
			</button>
			<button class="btn btn-xs btn-ghost" onclick={toggleHistory} aria-expanded={historyOpen}>
				{historyOpen ? 'Hide history' : 'History'}
			</button>
			<button class="btn btn-xs btn-outline" onclick={() => onDuplicate(automation)}>Duplicate</button>
			<button
				class="btn btn-xs {automation.enabled ? 'btn-warning' : 'btn-success'}"
				disabled={rowBusy}
				onclick={() => onToggle(automation)}
			>
				{#if toggling}
					<span class="loading loading-spinner loading-xs"></span>
				{:else if automation.enabled}
					Disable
				{:else}
					Enable
				{/if}
			</button>
			<button class="btn btn-xs btn-error btn-outline" disabled={rowBusy} onclick={() => onDelete(automation)}>
				{deleting ? 'Deleting...' : 'Delete'}
			</button>
			{#if automation.conversationId}
				<a class="btn btn-xs btn-ghost ml-auto" href="/chat/{automation.conversationId}">Conversation</a>
			{/if}
		</div>

		{#if historyOpen}
			<!-- #31 — run history: did past runs work, and what did they produce? -->
			<div class="rounded-xl border border-base-300/60 bg-base-200/20 p-3">
				<div class="flex items-center justify-between gap-2">
					<p class="text-[10px] font-semibold uppercase tracking-wide text-base-content/35">Run history</p>
					<button class="btn btn-ghost btn-xs" disabled={historyLoading} onclick={() => loadHistory(true)}>
						{historyLoading ? 'Loading…' : 'Refresh'}
					</button>
				</div>

				{#if historyError}
					<p class="mt-2 text-xs text-error">{historyError}</p>
				{:else if historyLoading && runs.length === 0}
					<p class="mt-2 text-xs text-base-content/50">Loading run history…</p>
				{:else if runs.length === 0}
					<p class="mt-2 text-xs text-base-content/50">No runs recorded yet.</p>
				{:else}
					<ul class="mt-2 space-y-1.5">
						{#each runs as run (run.id)}
							{@const link = runLink(run)}
							{@const cost = formatCost(run.costUsd)}
							<li class="rounded-lg border border-base-300/50 bg-base-100 px-2.5 py-2 text-xs">
								<div class="flex flex-wrap items-center gap-2">
									<span class="badge badge-xs {statusBadgeClass(run.status)}">{run.status}</span>
									<span class="text-base-content/70">{relativeTime(run.startedAt)}</span>
									<span class="text-base-content/40">{formatDate(run.startedAt)}</span>
									<span class="text-base-content/40">{formatDuration(run.durationMs)}</span>
									{#if run.trigger === 'manual'}
										<span class="badge badge-ghost badge-xs">manual</span>
									{:else if run.trigger === 'monitor'}
										<span class="badge badge-ghost badge-xs">monitor</span>
									{/if}
									{#if run.attempt > 1}
										<span class="badge badge-ghost badge-xs">retry {run.attempt}</span>
									{/if}
									{#if cost}
										<span class="text-base-content/50">{cost}</span>
									{/if}
									{#if link}
										<a class="link link-hover ml-auto text-primary" href={link.href}>{link.label}</a>
									{/if}
								</div>
								{#if run.error}
									<p class="mt-1 line-clamp-2 font-mono text-[11px] text-error/80">{run.error}</p>
								{:else if run.outputExcerpt}
									<p class="mt-1 line-clamp-2 text-[11px] text-base-content/55">{run.outputExcerpt}</p>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		{/if}
	</div>
</article>

<style>
	.shimmer-bar {
		animation: shimmer 1.6s ease-in-out infinite;
	}

	@keyframes shimmer {
		0% {
			transform: translateX(-100%);
		}
		100% {
			transform: translateX(300%);
		}
	}
</style>
