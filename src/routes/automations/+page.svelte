<svelte:head><title>Automations | AgentStudio</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import {
		deleteAutomationCommand,
		listAutomationsQuery,
		updateAutomationCommand,
	} from '$lib/automations';
	import { getAgentChoices } from '$lib/agents';
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import AutomationCard from '$lib/automations/AutomationCard.svelte';
	import AutomationCreateForm from '$lib/automations/AutomationCreateForm.svelte';
	import { isDueSoon, toTime } from '$lib/automations/automation-format';

	type AutomationRow = Awaited<ReturnType<typeof listAutomationsQuery>>[number];
	type AgentChoice = Awaited<ReturnType<typeof getAgentChoices>>[number];
	type SortMode = 'next_run' | 'updated' | 'status';

	let rows = $state<AutomationRow[]>([]);
	let agents = $state<AgentChoice[]>([]);
	let loading = $state(true);
	let deletingAutomationId = $state<string | null>(null);
	let togglingAutomationId = $state<string | null>(null);
	let sortMode = $state<SortMode>('next_run');
	let formError = $state<string | null>(null);
	let createMessage = $state<string | null>(null);
	let formSeed = $state<{
		description: string;
		cronExpression: string;
		prompt: string;
		enabled: boolean;
		conversationMode: 'new_each_run' | 'reuse';
		selectedAgentId: string;
	} | null>(null);

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
			const [automations, agentChoices] = await Promise.all([
				listAutomationsQuery(),
				getAgentChoices(),
			]);
			rows = automations;
			agents = agentChoices;
		} catch {
			formError = 'Unable to load automations right now. Try again in a moment.';
		} finally {
			loading = false;
		}
	}

	function handleDuplicate(automation: AutomationRow) {
		formSeed = {
			description: `${automation.description} (copy)`,
			cronExpression: automation.cronExpression,
			prompt: automation.prompt,
			enabled: automation.enabled,
			conversationMode: automation.conversationMode,
			selectedAgentId: automation.agentId ?? 'orchestrator',
		};
		createMessage = 'Copied automation settings into the creation studio.';
	}

	function handleCreated(message: string) {
		createMessage = message;
		formSeed = null;
		void loadPageData();
	}

	function handleFormError(message: string | null) {
		formError = message;
		if (message) createMessage = null;
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

<div class="flex h-full min-h-0 flex-col">
	<PageHeader
		title="Automations"
		subtitle={`${rows.length} total • ${enabledCount} enabled${dueSoonCount > 0 ? ` • ${dueSoonCount} due soon` : ''}`}
		live={dueSoonCount > 0}
	>
		{#snippet chips()}
			<span class="console-chip">{rows.length} total</span>
			<span class="console-chip">{enabledCount} enabled</span>
			{#if dueSoonCount > 0}
				<span class="console-chip is-warn">
					<span class="pulse-dot"></span>
					{dueSoonCount} due soon
				</span>
			{/if}
		{/snippet}
		{#snippet actions()}
			<div class="join">
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
		{/snippet}
	</PageHeader>

	<div class="min-h-0 flex-1 overflow-y-auto px-3 py-3 tablet:px-4 desktop:px-4 desktop:py-4 space-y-5">
		{#if formError}
			<div class="alert alert-error py-2 text-sm">{formError}</div>
		{/if}
		{#if createMessage}
			<div class="alert alert-success py-2 text-sm">{createMessage}</div>
		{/if}

		<div class="grid gap-4 xl:grid-cols-[1.2fr,0.8fr]">
			<div>
				{#if loading}
					<div class="flex justify-center card card-body bg-base-100 border-base-300 rounded-2xl border py-16">
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
							<AutomationCard
								{automation}
								toggling={togglingAutomationId === automation.id}
								deleting={deletingAutomationId === automation.id}
								onDuplicate={handleDuplicate}
								onToggle={toggleAutomation}
								onDelete={deleteAutomation}
							/>
						{/each}
					</div>
				{/if}
			</div>

			<div class="xl:sticky xl:top-3 xl:self-start">
				<AutomationCreateForm
					{agents}
					seed={formSeed}
					onCreated={handleCreated}
					onError={handleFormError}
				/>
			</div>
		</div>
	</div>
</div>
