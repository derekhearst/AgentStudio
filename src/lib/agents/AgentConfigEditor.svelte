<script lang="ts">
	import type { getAgent } from '$lib/agents'
	import ContentPanel from '$lib/ui/ContentPanel.svelte'
	import ModelSelector from '$lib/llm/ModelSelector.svelte'

	type AgentData = NonNullable<Awaited<ReturnType<typeof getAgent>>>
	type Agent = AgentData['agent']

	const HOOK_EVENTS = [
		'before_run', 'after_run', 'before_round', 'after_round', 'before_tool', 'after_tool',
		'on_compact', 'on_evaluator', 'on_subagent_spawn', 'on_approval_required',
		'on_user_question', 'on_run_failed', 'on_skill_loaded', 'on_tool_output_archived',
	] as const

	let { agent, agentId, onSave }: {
		agent: Agent
		agentId: string
		/**
		 * Called when the user clicks Save with valid input. Resolves to the updated
		 * agent (or null when the save fails server-side). The editor uses the
		 * resolution to flip back to view mode and stamp "Saved" in the header.
		 */
		onSave: (input: {
			systemPrompt: string
			model: string
			hooks: Record<string, string[]>
		}) => Promise<Agent | null>
	} = $props()

	let editing = $state(false)
	let saving = $state(false)
	let saveError = $state<string | null>(null)
	let savedFlag = $state(false)

	let draftSystemPrompt = $state('')
	let draftModel = $state('')
	let draftHookRefs = $state<Record<string, string>>({})

	function readAgentHooks(a: Agent): Record<string, string[]> {
		const config = (a.config ?? null) as { hooks?: unknown } | null
		if (!config?.hooks || typeof config.hooks !== 'object') return {}
		const out: Record<string, string[]> = {}
		for (const [event, refs] of Object.entries(config.hooks as Record<string, unknown>)) {
			if (Array.isArray(refs)) {
				const cleaned = refs.filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
				if (cleaned.length > 0) out[event] = cleaned
			}
		}
		return out
	}

	function syncDraft(a: Agent) {
		draftSystemPrompt = a.systemPrompt
		draftModel = a.model
		const persistedHooks = readAgentHooks(a)
		draftHookRefs = Object.fromEntries(
			HOOK_EVENTS.map((event) => [event, persistedHooks[event]?.join(', ') ?? '']),
		)
	}

	// Re-seed drafts whenever the agent prop changes (after a save returns the
	// updated row, or when the parent reloads).
	$effect(() => {
		syncDraft(agent)
	})

	function startEdit() {
		syncDraft(agent)
		saveError = null
		savedFlag = false
		editing = true
	}

	function cancelEdit() {
		editing = false
		saveError = null
		savedFlag = false
		syncDraft(agent)
	}

	async function save() {
		const systemPrompt = draftSystemPrompt.trim()
		const model = draftModel.trim()
		if (!systemPrompt) {
			saveError = 'System prompt cannot be empty.'
			return
		}
		if (!model) {
			saveError = 'Model cannot be empty.'
			return
		}

		saving = true
		saveError = null
		savedFlag = false
		try {
			// Convert `event → comma-separated string` back to `event → string[]`. Empty entries
			// drop out so updateAgentRecord can clear them via its empty-array semantics.
			const hooks: Record<string, string[]> = {}
			for (const [event, raw] of Object.entries(draftHookRefs)) {
				const refs = raw.split(',').map((r) => r.trim()).filter((r) => r.length > 0)
				if (refs.length > 0) hooks[event] = refs
			}
			const updated = await onSave({ systemPrompt, model, hooks })
			if (!updated) {
				saveError = 'Failed to save agent configuration.'
				return
			}
			editing = false
			savedFlag = true
		} catch (err) {
			saveError = err instanceof Error ? err.message : 'Failed to save agent configuration.'
		} finally {
			saving = false
		}
	}
</script>

<ContentPanel>
	{#snippet header()}
		<div class="flex min-w-0 flex-1 items-center justify-between gap-2">
			<h2 class="font-semibold">Agent configuration</h2>
			<div class="flex items-center gap-2">
				{#if savedFlag}
					<span class="text-xs text-success">Saved</span>
				{/if}
				{#if editing}
					<button class="btn btn-xs btn-ghost" onclick={cancelEdit} disabled={saving}>Cancel</button>
					<button class="btn btn-xs btn-primary" onclick={save} disabled={saving}>
						{saving ? 'Saving…' : 'Save'}
					</button>
				{:else}
					<button class="btn btn-xs btn-ghost" onclick={startEdit}>Edit</button>
				{/if}
			</div>
		</div>
	{/snippet}

	{#if saveError}
		<div class="alert alert-error mb-3 py-2 text-xs">{saveError}</div>
	{/if}

	<div class="mb-4">
		<p class="text-xs font-semibold uppercase tracking-wide text-base-content/45">Model</p>
		{#if editing}
			<div class="mt-2 max-w-md">
				<ModelSelector
					value={draftModel}
					showChevron={false}
					showBrowseBadge={false}
					onchange={(id: string) => {
						draftModel = id
					}}
				/>
			</div>
		{:else}
			<p class="mt-1 font-mono text-xs text-base-content/65">{agent.model}</p>
		{/if}
	</div>

	<div class="mb-2 border-t border-base-300/70"></div>

	<div class="mb-2 flex items-center justify-between gap-2">
		<p class="text-xs font-semibold uppercase tracking-wide text-base-content/45">System prompt</p>
		<a class="link link-primary text-[11px]" href="/agents/{agentId}/identity">Open identity editor →</a>
	</div>
	{#if editing}
		<textarea
			class="textarea textarea-bordered min-h-52 w-full text-xs leading-relaxed"
			bind:value={draftSystemPrompt}
		></textarea>
		<p class="mt-1 text-right text-[11px] text-base-content/45">{draftSystemPrompt.length} chars</p>
	{:else}
		<pre class="whitespace-pre-wrap text-xs leading-relaxed text-base-content/70">{agent.systemPrompt}</pre>
	{/if}

	<div class="mb-2 mt-4 border-t border-base-300/70"></div>

	<p class="mb-1 text-xs font-semibold uppercase tracking-wide text-base-content/45">Hook bindings</p>
	<p class="mb-2 text-[11px] leading-snug text-base-content/55">
		Bind opt-in built-in hook handlers OR (future) skill slugs to lifecycle events for this agent only. Globally-registered handlers (activity emit, etc.) fire automatically — bindings here are additive. <a href="/settings/hooks" class="link link-hover">View invocation log</a>.
	</p>
	{#if editing}
		<div class="space-y-1.5">
			{#each HOOK_EVENTS as event (event)}
				<label class="flex items-center gap-2 text-xs">
					<span class="w-44 shrink-0 font-mono text-[11px] text-base-content/65">{event}</span>
					<input
						type="text"
						class="input input-xs input-bordered flex-1 font-mono text-[11px]"
						placeholder="hook-ref-1, hook-ref-2"
						value={draftHookRefs[event] ?? ''}
						oninput={(e) => {
							draftHookRefs = { ...draftHookRefs, [event]: (e.currentTarget as HTMLInputElement).value }
						}}
					/>
				</label>
			{/each}
		</div>
	{:else}
		{@const persistedHooks = readAgentHooks(agent)}
		{#if Object.keys(persistedHooks).length > 0}
			<ul class="space-y-1.5 text-xs">
				{#each Object.entries(persistedHooks) as [event, refs] (event)}
					<li class="flex items-start gap-2">
						<span class="w-44 shrink-0 font-mono text-[11px] text-base-content/65">{event}</span>
						<div class="flex flex-1 flex-wrap gap-1">
							{#each refs as ref (ref)}
								<span class="badge badge-xs badge-outline font-mono">{ref}</span>
							{/each}
						</div>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="text-xs italic text-base-content/40">No per-agent hook bindings.</p>
		{/if}
	{/if}
</ContentPanel>
