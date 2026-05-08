<script lang="ts">
	import { createAutomationCommand } from '$lib/automations'
	import { getAgentChoices } from '$lib/agents'

	type AutomationMode = 'chat_followup' | 'research' | 'maintenance'
	type AutomationOutputTarget = 'chat_session' | 'artifact' | 'review_inbox'
	type AgentChoice = Awaited<ReturnType<typeof getAgentChoices>>[number]

	const CRON_PRESETS = [
		{ label: 'Hourly', expression: '0 * * * *' },
		{ label: 'Daily 9:00', expression: '0 9 * * *' },
		{ label: 'Weekdays 9:30', expression: '30 9 * * 1-5' },
		{ label: 'Every Monday', expression: '0 9 * * 1' },
		{ label: 'Month start', expression: '0 10 1 * *' },
	] as const

	let {
		agents,
		seed = null,
		onCreated,
		onError,
	} = $props<{
		agents: AgentChoice[]
		/**
		 * When set (e.g. duplicating an existing automation), pre-fills form state.
		 * Cleared by the parent after consumption.
		 */
		seed?: {
			description: string
			cronExpression: string
			prompt: string
			enabled: boolean
			conversationMode: 'new_each_run' | 'reuse'
			selectedAgentId: string
		} | null
		onCreated: (message: string) => void
		onError: (message: string | null) => void
	}>()

	let description = $state('')
	let cronExpression = $state('0 9 * * *')
	let prompt = $state('Summarize important updates since the last run and recommend next actions.')
	let conversationMode = $state<'new_each_run' | 'reuse'>('new_each_run')
	let mode = $state<AutomationMode>('chat_followup')
	let outputTarget = $state<AutomationOutputTarget>('chat_session')
	let enabled = $state(true)
	let selectedAgentId = $state('orchestrator')
	let saving = $state(false)

	$effect(() => {
		if (!seed) return
		description = seed.description
		cronExpression = seed.cronExpression
		prompt = seed.prompt
		enabled = seed.enabled
		conversationMode = seed.conversationMode
		selectedAgentId = seed.selectedAgentId
	})

	function selectPreset(expression: string) {
		cronExpression = expression
	}

	function clearMessage() {
		onError(null)
	}

	function validate(): string | null {
		if (!description.trim()) return 'Add a short description for this automation.'
		if (!cronExpression.trim()) return 'Add a cron expression for the schedule.'
		if (!prompt.trim()) return 'Add instructions for what should happen on each run.'
		return null
	}

	async function submit() {
		clearMessage()
		const validationError = validate()
		if (validationError) {
			onError(validationError)
			return
		}

		saving = true
		try {
			await createAutomationCommand({
				agentId: selectedAgentId === 'orchestrator' ? null : selectedAgentId,
				description: description.trim(),
				cronExpression: cronExpression.trim(),
				prompt: prompt.trim(),
				enabled,
				conversationMode,
				mode,
				outputTarget,
			})
			description = ''
			onCreated('Automation created successfully.')
		} catch {
			onError('Failed to create automation. Check values and try again.')
		} finally {
			saving = false
		}
	}
</script>

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
			event.preventDefault()
			void submit()
		}}
	>
		<fieldset class="fieldset">
			<legend class="fieldset-legend text-xs">Description</legend>
			<input
				class="input input-bordered"
				placeholder="Daily customer sentiment scan"
				bind:value={description}
				oninput={clearMessage}
			/>
		</fieldset>

		<fieldset class="fieldset">
			<legend class="fieldset-legend text-xs">Agent</legend>
			<select class="select select-bordered" bind:value={selectedAgentId} oninput={clearMessage}>
				<option value="orchestrator">Orchestrator (default)</option>
				{#each agents as agent (agent.id)}
					<option value={agent.id}>{agent.name} ({agent.status})</option>
				{/each}
			</select>
		</fieldset>

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
				oninput={clearMessage}
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

		<div class="space-y-2 rounded-xl border border-base-300/70 bg-base-200/20 p-3">
			<p class="text-xs font-medium">Execution mode</p>
			<select
				data-testid="automation-mode-select"
				class="select select-bordered select-sm w-full"
				bind:value={mode}
				onchange={clearMessage}
			>
				<option value="chat_followup">Chat followup — append prompt to a conversation (default)</option>
				<option value="research">Research — open a research run with citations</option>
				<option value="maintenance">Maintenance — run hygiene work, no chat surface</option>
			</select>

			{#if mode === 'maintenance'}
				<div class="mt-2 space-y-1">
					<p class="text-xs text-base-content/70">Output target</p>
					<select
						data-testid="automation-output-target-select"
						class="select select-bordered select-sm w-full"
						bind:value={outputTarget}
						onchange={clearMessage}
					>
						<option value="chat_session">Chat session — assistant message in the conversation</option>
						<option value="review_inbox">Review inbox — automation_summary item</option>
						<option value="artifact">Artifact — write a versioned artifact (project must be bound)</option>
					</select>
				</div>
			{/if}
		</div>

		<fieldset class="fieldset">
			<legend class="fieldset-legend text-xs">Prompt</legend>
			<textarea
				class="textarea textarea-bordered min-h-28"
				placeholder="What should this automation do every run?"
				bind:value={prompt}
				oninput={clearMessage}
			></textarea>
		</fieldset>

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
