<svelte:head><title>Monitors | AgentStudio</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import { confirmDialog } from '$lib/ui/confirm-dialog.svelte';
	import {
		cancelMonitorCommand,
		checkMonitorNowCommand,
		extendMonitorCommand,
		listMonitorsQuery,
		setMonitorPausedCommand
	} from '$lib/monitors/monitors.remote';
	import MonitorCard from '$lib/monitors/MonitorCard.svelte';
	import MonitorCreateForm from '$lib/monitors/MonitorCreateForm.svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import { remoteErrorMessage } from '$lib/ui/remote-error';

	type Result = Awaited<ReturnType<typeof listMonitorsQuery>>;
	type MonitorRow = Result['monitors'][number];

	let rows = $state<MonitorRow[]>([]);
	let loading = $state(true);
	let showAll = $state(false);
	let busyId = $state<string | null>(null);
	let error = $state<string | null>(null);
	let notice = $state<string | null>(null);

	const activeCount = $derived(rows.filter((row) => row.status === 'active').length);
	const armedCount = $derived(rows.filter((row) => row.status === 'active' && row.conditionMet).length);

	onMount(() => void load());

	async function load() {
		loading = true;
		try {
			const result = await listMonitorsQuery({ openOnly: !showAll });
			rows = result.monitors;
			error = null;
		} catch {
			error = 'Unable to load monitors right now.';
		} finally {
			loading = false;
		}
	}

	async function withBusy(monitor: MonitorRow, run: () => Promise<string | null>) {
		busyId = monitor.id;
		error = null;
		notice = null;
		try {
			notice = await run();
			await load();
		} catch (err) {
			error = remoteErrorMessage(err, 'That did not work.');
		} finally {
			busyId = null;
		}
	}

	async function handleCancel(monitor: MonitorRow) {
		const ok = await confirmDialog({
			title: `Cancel monitor "${monitor.name}"?`,
			message: 'This cannot be undone.',
			confirmLabel: 'Cancel monitor',
			cancelLabel: 'Keep it',
			variant: 'danger'
		});
		if (!ok) return;
		void withBusy(monitor, async () => {
			await cancelMonitorCommand({ id: monitor.id });
			return `Canceled "${monitor.name}".`;
		});
	}

	function handleTogglePause(monitor: MonitorRow) {
		const paused = monitor.status !== 'paused';
		void withBusy(monitor, async () => {
			await setMonitorPausedCommand({ id: monitor.id, paused });
			return paused
				? `Paused "${monitor.name}" — its deadline still applies.`
				: `Resumed "${monitor.name}".`;
		});
	}

	function handleExtend(monitor: MonitorRow) {
		const answer = window.prompt('Extend by how many days (from now)?', '7');
		if (answer === null) return;
		const days = Number(answer);
		if (!Number.isFinite(days) || days <= 0) {
			error = 'Enter a positive number of days.';
			return;
		}
		void withBusy(monitor, async () => {
			const updated = await extendMonitorCommand({
				id: monitor.id,
				additionalDays: days,
				// An extension without budget is not an extension; top the check budget back up
				// to what it started with.
				additionalChecks: monitor.checkCount
			});
			return updated ? `"${monitor.name}" now expires ${updated.deadlineAt.toLocaleString()}.` : null;
		});
	}

	function handleCheckNow(monitor: MonitorRow) {
		void withBusy(monitor, async () => {
			await checkMonitorNowCommand({ id: monitor.id });
			return `Queued a check for "${monitor.name}" — refresh in a moment.`;
		});
	}

	function handleCreated(message: string) {
		notice = message;
		error = null;
		void load();
	}
</script>

<div class="flex h-full min-h-0 flex-col">
	<PageHeader
		title="Monitors"
		subtitle="Watch for a condition and act when it changes"
		live={armedCount > 0}
	>
		{#snippet chips()}
			<span class="console-chip">{rows.length} shown</span>
			<span class="console-chip">{activeCount} active</span>
			{#if armedCount > 0}
				<span class="console-chip is-warn">
					<span class="pulse-dot"></span>
					{armedCount} condition met
				</span>
			{/if}
		{/snippet}
		{#snippet actions()}
			<label class="flex cursor-pointer items-center gap-1.5 text-xs">
				<input
					type="checkbox"
					class="toggle toggle-xs"
					bind:checked={showAll}
					onchange={() => void load()}
				/>
				<span>Include finished</span>
			</label>
			<button class="btn btn-ghost btn-xs" type="button" onclick={() => void load()} disabled={loading}>
				{loading ? 'Loading…' : 'Refresh'}
			</button>
		{/snippet}
	</PageHeader>

	<div class="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3 tablet:px-4 desktop:px-4 desktop:py-4">
		{#if error}
			<div role="alert" class="alert alert-error py-2 text-sm">{error}</div>
		{/if}
		{#if notice}
			<div role="alert" class="alert alert-success py-2 text-sm">{notice}</div>
		{/if}

		<div class="grid gap-4 xl:grid-cols-[1.2fr,0.8fr]">
			<div class="space-y-3">
				{#if loading}
					<div class="card card-body border-base-300 flex items-center justify-center rounded-2xl border bg-base-100 py-16">
						<span class="loading loading-spinner loading-lg text-primary"></span>
					</div>
				{:else if rows.length === 0}
					<div class="rounded-2xl border border-dashed border-base-300 bg-base-100/80 py-16 text-center">
						<p class="text-base font-medium">Nothing is being watched</p>
						<p class="mt-1 text-sm opacity-55">
							Create a monitor here, or ask an agent to leave one behind mid-conversation.
						</p>
					</div>
				{:else}
					{#each rows as monitor (monitor.id)}
						<MonitorCard
							{monitor}
							busy={busyId === monitor.id}
							onCancel={handleCancel}
							onTogglePause={handleTogglePause}
							onExtend={handleExtend}
							onCheckNow={handleCheckNow}
						/>
					{/each}
				{/if}
			</div>

			<MonitorCreateForm onCreated={handleCreated} />
		</div>
	</div>
</div>
