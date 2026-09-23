<script lang="ts">
	import { createAutomationCommand } from '$lib/automations'
	import { COMMON_TIME_ZONES, DEFAULT_TIMEZONE, isValidTimeZone } from '$lib/automations/cron'
	import { getAgentChoices } from '$lib/agents'
	import { remoteErrorMessage } from '$lib/ui/remote-error'

	type AutomationMode = 'chat_followup' | 'research' | 'maintenance'
	type AutomationOutputTarget = 'chat_session' | 'review_inbox'
	type AgentChoice = Awaited<ReturnType<typeof getAgentChoices>>[number]

	const CRON_PRESETS = [
		{ label: 'Hourly', expression: '0 * * * *' },
		{ label: 'Daily 9:00', expression: '0 9 * * *' },
		{ label: 'Weekdays 9:30', expression: '30 9 * * 1-5' },
		{ label: 'Every Monday', expression: '0 9 * * 1' },
		{ label: 'Month start', expression: '0 10 1 * *' },
	] as const

	function detectTimeZone(): string {
		try {
			const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone
			return resolved && isValidTimeZone(resolved) ? resolved : DEFAULT_TIMEZONE
		} catch {
			return DEFAULT_TIMEZONE
		}
	}

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
			timezone?: string
			prompt: string
			enabled: boolean
			conversationMode: 'new_each_run' | 'reuse'
			mode?: AutomationMode
			outputTarget?: AutomationOutputTarget
			selectedAgentId: string
		} | null
		onCreated: (message: string) => void
		onError: (message: string | null) => void
	}>()

	let description = $state('')
	let cronExpression = $state('0 9 * * *')
	// #30 — the cron expression is a wall-clock schedule, so it needs a zone to mean anything.
	// Seed from the browser's own zone when we recognise it, else the app default.
	let timezone = $state(detectTimeZone())
	let prompt = $state('Summarize important updates since the last run and recommend next actions.')
	let conversationMode = $state<'new_each_run' | 'reuse'>('new_each_run')
	let mode = $state<AutomationMode>('chat_followup')
	let outputTarget = $state<AutomationOutputTarget>('chat_session')
	let enabled = $state(true)
	let selectedAgentId = $state('orchestrator')
	let saving = $state(false)

	// The picker offers the common zones plus whatever the browser reports, so a detected or
	// duplicated zone is always selectable even when it isn't on the short list.
	const timeZoneOptions = $derived(Array.from(new Set<string>([...COMMON_TIME_ZONES, timezone])).sort())

	$effect(() => {
		if (!seed) return
		description = seed.description
		cronExpression = seed.cronExpression
		if (seed.timezone) timezone = seed.timezone
		prompt = seed.prompt
		enabled = seed.enabled
		conversationMode = seed.conversationMode
		// A copy that silently fell back to chat_followup would replay a research or
		// maintenance prompt into a chat thread instead.
		mode = seed.mode ?? 'chat_followup'
		outputTarget = seed.outputTarget ?? 'chat_session'
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
		if (!timezone.trim() || !isValidTimeZone(timezone.trim()))
			return 'Pick a valid IANA time zone for the schedule.'
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
				timezone: timezone.trim(),
				prompt: prompt.trim(),
				enabled,
				conversationMode,
				mode,
				outputTarget,
			})
			description = ''
			onCreated('Automation created successfully.')
		} catch (err) {
			// A bad schedule comes back naming the field and the reason; show that.
			onError(remoteErrorMessage(err, 'Failed to create automation. Check values and try again.'))
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
			<p class="text-[10px] text-base-content/45">
				Ranges (<code>1-5</code>), lists (<code>1,3,5</code>), steps (<code>*/15</code>), names
				(<code>MON</code>) and <code>@daily</code>-style aliases are all accepted.
			</p>

			<div class="flex items-center justify-between pt-1">
				<span class="label-text text-xs">Time zone</span>
				<span class="text-[10px] text-base-content/45">The expression is read in this zone</span>
			</div>
			<select
				data-testid="automation-timezone-select"
				class="select select-bordered w-full text-sm"
				bind:value={timezone}
				onchange={clearMessage}
			>
				{#each timeZoneOptions as zone (zone)}
					<option value={zone}>{zone}</option>
				{/each}
			</select>
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
					</select>
					<!-- #38 — the digest is otherwise only reachable from the /activity opt-in. -->
					<p class="text-[11px] text-base-content/55">
						A prompt of just <code>{'{{usage_digest}}'}</code> (or <code>{'{{usage_digest:30}}'}</code> for 30 days) sends
						the usage numbers from Activity instead, with no model call.
					</p>
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
