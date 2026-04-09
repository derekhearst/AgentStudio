<svelte:head><title>Automations | AgentStudio</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import {
		createAutomationCommand,
		deleteAutomationCommand,
		listAutomationsQuery,
		updateAutomationCommand,
	} from '$lib/automation';
	import { getAgentChoices } from '$lib/agents';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';

	type AutomationRow = Awaited<ReturnType<typeof listAutomationsQuery>>[number];
	type AgentChoice = Awaited<ReturnType<typeof getAgentChoices>>[number];
	type SortMode = 'next_run' | 'updated' | 'status';

	const CRON_PRESETS = [
		{ label: 'Hourly', expression: '0 * * * *' },
		{ label: 'Daily 9:00', expression: '0 9 * * *' },
		{ label: 'Weekdays 9:30', expression: '30 9 * * 1-5' },
		{ label: 'Every Monday', expression: '0 9 * * 1' },
		{ label: 'Month start', expression: '0 10 1 * *' },
	] as const;

	let rows = $state<AutomationRow[]>([]);
	let agents = $state<AgentChoice[]>([]);
	let loading = $state(true);
	let saving = $state(false);
	let deletingAutomationId = $state<string | null>(null);
	let togglingAutomationId = $state<string | null>(null);
	let sortMode = $state<SortMode>('next_run');
	let formError = $state<string | null>(null);
	let createMessage = $state<string | null>(null);

	let description = $state('');
	let cronExpression = $state('0 9 * * *');
	let prompt = $state('Summarize important updates since the last run and recommend next actions.');
	let conversationMode = $state<'new_each_run' | 'reuse'>('new_each_run');
	let enabled = $state(true);
	let selectedAgentId = $state('orchestrator');

	const enabledCount = $derived(rows.filter((row) => row.enabled).length);
	const dueSoonCount = $derived(rows.filter((row) => isDueSoon(row.nextRunAt)).length);

	const sortedRows = $derived.by(() => {
		const list = [...rows];

		if (sortMode === 'status') {
			return list.sort((a, b) => Number(b.enabled) - Number(a.enabled));
		}

		if (sortMode === 'updated') {
			return list.sort((a, b) => toTime(b.updatedAt) - toTime(a.updatedAt));
		}

		return list.sort((a, b) => {
			const aTime = toTime(a.nextRunAt);
			const bTime = toTime(b.nextRunAt);
			if (aTime === 0 && bTime === 0) return 0;
			if (aTime === 0) return 1;
			if (bTime === 0) return -1;
			return aTime - bTime;
		});
	});

	onMount(() => {
		void loadPageData();
	});

	async function loadPageData() {
		loading = true;
		formError = null;
		try {
			const [automations, agentChoices] = await Promise.all([listAutomationsQuery(), getAgentChoices()]);
			rows = automations;
			agents = agentChoices;
		} catch {
			formError = 'Unable to load automations right now. Try again in a moment.';
		} finally {
			loading = false;
		}
	}

	function toTime(value: Date | string | null): number {
		if (!value) return 0;
		const date = typeof value === 'string' ? new Date(value) : value;
		const time = date.getTime();
		return Number.isNaN(time) ? 0 : time;
	}

	function formatDate(value: Date | string | null): string {
		if (!value) return 'Unscheduled';
		const date = typeof value === 'string' ? new Date(value) : value;
		return date.toLocaleString();
	}

	function relativeTime(value: Date | string | null): string {
		if (!value) return 'Never';
		const date = typeof value === 'string' ? new Date(value) : value;
		const diffMs = Date.now() - date.getTime();
		if (Number.isNaN(diffMs)) return 'Unknown';
		if (Math.abs(diffMs) < 60_000) return 'Just now';
		const minutes = Math.round(diffMs / 60_000);
		if (Math.abs(minutes) < 60) return minutes > 0 ? `${minutes}m ago` : `in ${Math.abs(minutes)}m`;
		const hours = Math.round(minutes / 60);
		if (Math.abs(hours) < 24) return hours > 0 ? `${hours}h ago` : `in ${Math.abs(hours)}h`;
		const days = Math.round(hours / 24);
		return days > 0 ? `${days}d ago` : `in ${Math.abs(days)}d`;
	}

	function isDueSoon(value: Date | string | null): boolean {
		if (!value) return false;
		const ms = toTime(value);
		if (ms === 0) return false;
		const diff = ms - Date.now();
		return diff >= 0 && diff <= 3_600_000;
	}

	function selectPreset(expression: string) {
		cronExpression = expression;
	}

	function fillFromAutomation(automation: AutomationRow) {
		description = `${automation.description} (copy)`;
		cronExpression = automation.cronExpression;
		prompt = automation.prompt;
		enabled = automation.enabled;
		conversationMode = automation.conversationMode;
		selectedAgentId = automation.agentId ?? 'orchestrator';
		createMessage = 'Copied automation settings into the creation studio.';
	}

	function clearCreateMessage() {
		createMessage = null;
	}

	function validateCreateForm(): string | null {
		if (!description.trim()) return 'Add a short description for this automation.';
		if (!cronExpression.trim()) return 'Add a cron expression for the schedule.';
		if (!prompt.trim()) return 'Add instructions for what should happen on each run.';
		return null;
	}

	async function createAutomation() {
		clearCreateMessage();
		formError = validateCreateForm();
		if (formError) return;

		saving = true;
		try {
			await createAutomationCommand({
				agentId: selectedAgentId === 'orchestrator' ? null : selectedAgentId,
				description: description.trim(),
				cronExpression: cronExpression.trim(),
				prompt: prompt.trim(),
				enabled,
				conversationMode,
			});

			await loadPageData();
			description = '';
			createMessage = 'Automation created successfully.';
		} catch {
			formError = 'Failed to create automation. Check values and try again.';
		} finally {
			saving = false;
		}
	}

	async function toggleAutomation(automation: AutomationRow) {
		togglingAutomationId = automation.id;
		formError = null;
		createMessage = null;
		try {
			await updateAutomationCommand({ id: automation.id, enabled: !automation.enabled });
			await loadPageData();
		} catch {
			formError = 'Unable to update automation status right now.';
		} finally {
			togglingAutomationId = null;
		}
	}

	async function deleteAutomation(automation: AutomationRow) {
		const confirmed = window.confirm(`Delete automation "${automation.description}"?`);
		if (!confirmed) return;

		deletingAutomationId = automation.id;
		formError = null;
		createMessage = null;
		try {
			await deleteAutomationCommand({ id: automation.id });
			await loadPageData();
		} catch {
			formError = 'Unable to delete automation right now.';
		} finally {
			deletingAutomationId = null;
		}
	}
</script>

<section class="space-y-5">
	<ContentPanel>
		{#snippet header()}
			<div class="flex min-w-0 flex-1 items-start justify-between gap-3">
				<div>
					<h1 class="text-xl font-bold sm:text-3xl">Automations</h1>
					<p class="mt-0.5 text-xs text-base-content/60 sm:text-sm">
						{rows.length} total
						<span class="mx-1.5">•</span>
						{enabledCount} enabled
						{#if dueSoonCount > 0}
							<span class="ml-2 inline-flex items-center gap-1 text-warning">
								<span class="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-warning"></span>
								{dueSoonCount} due soon
							</span>
						{/if}
					</p>
				</div>
				<div class="join shrink-0">
					<button
						class="btn join-item btn-xs {sortMode === 'next_run' ? 'btn-neutral' : 'btn-ghost'}"
						onclick={() => (sortMode = 'next_run')}
					>Next run</button>
					<button
						class="btn join-item btn-xs {sortMode === 'updated' ? 'btn-neutral' : 'btn-ghost'}"
						onclick={() => (sortMode = 'updated')}
					>Updated</button>
					<button
						class="btn join-item btn-xs {sortMode === 'status' ? 'btn-neutral' : 'btn-ghost'}"
						onclick={() => (sortMode = 'status')}
					>Status</button>
				</div>
			</div>
		{/snippet}
	</ContentPanel>

	{#if formError}
		<div class="alert alert-error py-2 text-sm">{formError}</div>
	{/if}
	{#if createMessage}
		<div class="alert alert-success py-2 text-sm">{createMessage}</div>
	{/if}

	<div class="grid gap-4 xl:grid-cols-[1.2fr,0.8fr]">
		<div>
			{#if loading}
				<div class="flex justify-center rounded-2xl border border-base-300 bg-base-100 py-16">
					<span class="loading loading-spinner loading-lg text-primary"></span>
				</div>
			{:else if sortedRows.length === 0}
				<div class="rounded-2xl border border-dashed border-base-300 bg-base-100/80 py-16 text-center">
					<p class="text-base font-medium">No automations yet</p>
					<p class="mt-1 text-sm text-base-content/55">Use the creation studio to build your first recurring workflow.</p>
				</div>
			{:else}
				<div class="space-y-4">
					{#each sortedRows as automation (automation.id)}
						{@const rowBusy = togglingAutomationId === automation.id || deletingAutomationId === automation.id}
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
									<button class="btn btn-xs btn-outline" onclick={() => fillFromAutomation(automation)}>Duplicate</button>
									<button
										class="btn btn-xs {automation.enabled ? 'btn-warning' : 'btn-success'}"
										disabled={rowBusy}
										onclick={() => toggleAutomation(automation)}
									>
										{#if togglingAutomationId === automation.id}
											<span class="loading loading-spinner loading-xs"></span>
										{:else if automation.enabled}
											Disable
										{:else}
											Enable
										{/if}
									</button>
									<button
										class="btn btn-xs btn-error btn-outline"
										disabled={rowBusy}
										onclick={() => deleteAutomation(automation)}
									>
										{deletingAutomationId === automation.id ? 'Deleting...' : 'Delete'}
									</button>
									{#if automation.conversationId}
										<a class="btn btn-xs btn-ghost ml-auto" href="/chat/{automation.conversationId}">Conversation</a>
									{/if}
								</div>
							</div>
						</article>
					{/each}
				</div>
			{/if}
		</div>

		<div class="xl:sticky xl:top-3 xl:self-start">
			<div class="overflow-hidden rounded-2xl border border-base-300 bg-base-100">
				<div class="bg-linear-to-r from-primary/20 via-accent/10 to-secondary/20 p-4">
					<p class="text-[11px] font-semibold uppercase tracking-[0.12em] text-primary/80">Creation studio</p>
					<h2 class="mt-1 text-lg font-semibold">Create a new automation</h2>
					<p class="mt-1 text-sm text-base-content/65">
						Design a recurring workflow with schedule presets, conversation behavior, and a reusable prompt.
					</p>
				</div>

				<form
					class="space-y-4 p-4"
					onsubmit={(event) => {
						event.preventDefault();
						void createAutomation();
					}}
				>
					<label class="form-control">
						<div class="label"><span class="label-text text-xs">Description</span></div>
						<input
							class="input input-bordered"
							placeholder="Daily customer sentiment scan"
							bind:value={description}
							oninput={clearCreateMessage}
						/>
					</label>

					<label class="form-control">
						<div class="label"><span class="label-text text-xs">Agent</span></div>
						<select class="select select-bordered" bind:value={selectedAgentId} oninput={clearCreateMessage}>
							<option value="orchestrator">Orchestrator (default)</option>
							{#each agents as agent (agent.id)}
								<option value={agent.id}>{agent.name} ({agent.status})</option>
							{/each}
						</select>
					</label>

					<div class="space-y-2">
						<div class="flex items-center justify-between">
							<span class="label-text text-xs">Cron schedule</span>
							<span class="text-[10px] text-base-content/45">Use presets or custom</span>
						</div>
						<div class="flex flex-wrap gap-1.5">
							{#each CRON_PRESETS as preset (preset.expression)}
								<button
									type="button"
									class="btn btn-xs {cronExpression === preset.expression ? 'btn-primary' : 'btn-ghost'}"
									onclick={() => selectPreset(preset.expression)}
								>{preset.label}</button>
							{/each}
						</div>
						<input
							class="input input-bordered w-full font-mono text-sm"
							placeholder="0 9 * * *"
							bind:value={cronExpression}
							oninput={clearCreateMessage}
						/>
					</div>

					<div class="space-y-2 rounded-xl border border-base-300/70 bg-base-200/20 p-3">
						<p class="text-xs font-medium">Conversation mode</p>
						<div class="join w-full">
							<button
								type="button"
								class="btn join-item btn-sm flex-1 {conversationMode === 'new_each_run' ? 'btn-neutral' : 'btn-ghost'}"
								onclick={() => (conversationMode = 'new_each_run')}
							>New each run</button>
							<button
								type="button"
								class="btn join-item btn-sm flex-1 {conversationMode === 'reuse' ? 'btn-neutral' : 'btn-ghost'}"
								onclick={() => (conversationMode = 'reuse')}
							>Reuse thread</button>
						</div>
					</div>

					<label class="form-control">
						<div class="label"><span class="label-text text-xs">Prompt</span></div>
						<textarea
							class="textarea textarea-bordered min-h-28"
							placeholder="What should this automation do every run?"
							bind:value={prompt}
							oninput={clearCreateMessage}
						></textarea>
					</label>

					<label class="label cursor-pointer justify-start gap-2 rounded-lg border border-base-300/70 bg-base-200/20 px-3 py-2">
						<input class="toggle toggle-success toggle-sm" type="checkbox" bind:checked={enabled} />
						<span class="label-text text-sm">Enable immediately</span>
					</label>

					<button class="btn btn-primary w-full" type="submit" disabled={saving}>
						{#if saving}
							<span class="loading loading-spinner loading-xs"></span>
							Creating automation...
						{:else}
							Create automation
						{/if}
					</button>
				</form>
			</div>
		</div>
	</div>
</section>

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
