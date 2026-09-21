<script lang="ts">
	import { describeCondition, monitorConditionSchema, isTerminalStatus } from '$lib/monitors/condition';
	import type { listMonitorsQuery } from '$lib/monitors/monitors.remote';
	import { formatDateTime, relativeTimeBidirectional } from '$lib/util/relative-time';

	type MonitorRow = Awaited<ReturnType<typeof listMonitorsQuery>>['monitors'][number];

	let {
		monitor,
		busy = false,
		onCancel,
		onTogglePause,
		onExtend,
		onCheckNow
	}: {
		monitor: MonitorRow;
		busy?: boolean;
		onCancel: (monitor: MonitorRow) => void;
		onTogglePause: (monitor: MonitorRow) => void;
		onExtend: (monitor: MonitorRow) => void;
		onCheckNow: (monitor: MonitorRow) => void;
	} = $props();

	const watching = $derived.by(() => {
		try {
			return describeCondition(monitorConditionSchema.parse(monitor.condition));
		} catch {
			return 'condition can no longer be read';
		}
	});

	const terminal = $derived(isTerminalStatus(monitor.status));
	const budgetPct = $derived(
		Math.min(100, Math.round((monitor.checkCount / Math.max(1, monitor.maxChecks)) * 100))
	);

	function statusTone(status: string): string {
		switch (status) {
			case 'active':
				return 'badge-success';
			case 'paused':
				return 'badge-warning';
			case 'fired':
				return 'badge-info';
			case 'failed':
				return 'badge-error';
			case 'expired':
			case 'exhausted':
				return 'badge-neutral';
			default:
				return 'badge-ghost';
		}
	}

	function intervalLabel(seconds: number): string {
		if (seconds % 3600 === 0) return `${seconds / 3600}h`;
		if (seconds % 60 === 0) return `${seconds / 60}m`;
		return `${seconds}s`;
	}
</script>

<div class="card border-base-300 bg-base-100 rounded-2xl border" data-testid="monitor-card">
	<div class="card-body gap-3 p-4">
		<div class="flex flex-wrap items-start justify-between gap-2">
			<div class="min-w-0">
				<p class="truncate text-sm font-semibold">{monitor.name}</p>
				<p class="mt-0.5 text-xs opacity-70">
					Watching: <span class="font-mono">{watching}</span>
				</p>
			</div>
			<div class="flex shrink-0 items-center gap-1.5">
				<span class="badge badge-sm {statusTone(monitor.status)}">{monitor.status}</span>
				<span class="badge badge-sm badge-outline">{monitor.action}</span>
			</div>
		</div>

		<div class="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
			<div>
				<p class="opacity-55">Every</p>
				<p class="font-medium">{intervalLabel(monitor.intervalSeconds)}{monitor.oneShot ? ' · one-shot' : ' · repeating'}</p>
			</div>
			<div>
				<p class="opacity-55">Next check</p>
				<p class="font-medium">
					{terminal ? '—' : relativeTimeBidirectional(monitor.nextCheckAt)}
				</p>
			</div>
			<div>
				<p class="opacity-55">Expires</p>
				<p class="font-medium" title={formatDateTime(monitor.deadlineAt)}>
					{relativeTimeBidirectional(monitor.deadlineAt)}
				</p>
			</div>
			<div>
				<p class="opacity-55">Checks used</p>
				<p class="font-medium">{monitor.checkCount} / {monitor.maxChecks}</p>
				<progress class="progress progress-primary h-1 w-full" value={budgetPct} max="100"></progress>
			</div>
		</div>

		{#if monitor.lastObservation}
			<div class="rounded-xl border border-base-300/60 bg-base-200/40 p-2.5">
				<p class="text-[10px] font-semibold uppercase tracking-wide opacity-55">
					Last observed · {formatDateTime(monitor.lastObservation.observedAt)}
					{#if monitor.conditionMet}
						<span class="badge badge-xs badge-success ml-1">condition met</span>
					{/if}
				</p>
				{#if monitor.lastObservation.note}
					<p class="mt-1 text-xs">{monitor.lastObservation.note}</p>
				{/if}
				<pre class="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all text-[11px] opacity-75">{monitor.lastObservation.value.slice(0, 600)}</pre>
			</div>
		{:else}
			<p class="text-xs italic opacity-55">No observation yet — the first check records a baseline.</p>
		{/if}

		{#if monitor.lastError}
			<div role="alert" class="alert alert-error alert-soft py-2 text-xs">
				<span class="break-all">{monitor.lastError}</span>
			</div>
		{/if}

		{#if monitor.fireCount > 0}
			<p class="text-xs opacity-70">
				Fired {monitor.fireCount}×, last {relativeTimeBidirectional(monitor.lastFiredAt)}
				{#if monitor.lastFireResult}
					<span class="font-mono opacity-60">· {JSON.stringify(monitor.lastFireResult).slice(0, 160)}</span>
				{/if}
			</p>
		{/if}

		<div class="card-actions justify-end gap-1.5">
			{#if monitor.status === 'active' || monitor.status === 'paused'}
				<button class="btn btn-ghost btn-xs" type="button" disabled={busy} onclick={() => onTogglePause(monitor)}>
					{monitor.status === 'paused' ? 'Resume' : 'Pause'}
				</button>
			{/if}
			{#if monitor.status === 'active'}
				<button class="btn btn-ghost btn-xs" type="button" disabled={busy} onclick={() => onCheckNow(monitor)}>
					Check now
				</button>
			{/if}
			{#if monitor.status !== 'canceled'}
				<button class="btn btn-ghost btn-xs" type="button" disabled={busy} onclick={() => onExtend(monitor)}>
					Extend
				</button>
			{/if}
			{#if !terminal}
				<button class="btn btn-error btn-outline btn-xs" type="button" disabled={busy} onclick={() => onCancel(monitor)}>
					Cancel
				</button>
			{/if}
		</div>
	</div>
</div>
