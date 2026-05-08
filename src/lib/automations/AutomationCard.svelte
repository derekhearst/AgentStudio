<script lang="ts">
	import { listAutomationsQuery } from '$lib/automations'
	import { formatDate, relativeTime } from './automation-format'

	type AutomationRow = Awaited<ReturnType<typeof listAutomationsQuery>>[number]

	let {
		automation,
		toggling = false,
		deleting = false,
		onDuplicate,
		onToggle,
		onDelete,
	} = $props<{
		automation: AutomationRow
		toggling?: boolean
		deleting?: boolean
		onDuplicate: (automation: AutomationRow) => void
		onToggle: (automation: AutomationRow) => void
		onDelete: (automation: AutomationRow) => void
	}>()

	const rowBusy = $derived(toggling || deleting)
</script>

<article
	class="group relative overflow-hidden rounded-2xl border border-base-300 bg-base-100 transition-all duration-200 hover:border-base-content/20 hover:shadow-xl hover:shadow-base-content/5"
>
	<div class="relative h-0.75 w-full overflow-hidden {automation.enabled ? 'bg-success/30' : 'bg-base-300/60'}">
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
			<span class="badge badge-sm {automation.enabled ? 'badge-success' : 'badge-ghost'}">
				{automation.enabled ? 'enabled' : 'disabled'}
			</span>
		</div>

		<div class="rounded-xl border border-base-300/60 bg-base-200/20 p-3">
			<p class="text-[10px] font-semibold uppercase tracking-wide text-base-content/35">Prompt</p>
			<p class="mt-1 line-clamp-3 text-sm text-base-content/70">{automation.prompt}</p>
		</div>

		<div class="grid gap-2 text-xs text-base-content/60 sm:grid-cols-2">
			<div class="rounded-lg border border-base-300/60 bg-base-200/20 px-3 py-2">
				<p class="text-[10px] uppercase tracking-wide text-base-content/35">Cron</p>
				<p class="mt-0.5 font-mono text-[11px]">{automation.cronExpression}</p>
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
