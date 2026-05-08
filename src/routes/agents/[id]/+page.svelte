<svelte:head><title>{data?.agent.name ?? 'Agent'} | AgentStudio</title></svelte:head>

<script lang="ts">
	import { page } from '$app/state'
	import { onMount, onDestroy } from 'svelte'
	import { getAgent, updateAgentCommand } from '$lib/agents'
	import ModelSelector from '$lib/llm/ModelSelector.svelte'
	import ContentPanel from '$lib/ui/ContentPanel.svelte'
	import PageHeader from '$lib/ui/PageHeader.svelte'
	import AgentStatsGrid from '$lib/agents/AgentStatsGrid.svelte'
	import AgentSessionsList from '$lib/agents/AgentSessionsList.svelte'
	import {
		agentColor,
		agentInitials,
		describeSchedule,
		modelShortName,
		relativeTime,
	} from '$lib/agents/agent-format'

	type AgentData = NonNullable<Awaited<ReturnType<typeof getAgent>>>
	type StreamEntry = { conversationId: string; agentId: string; delta: string }

	const agentId = $derived(page.params.id ?? '')
	let data = $state<AgentData | null>(null)
	let loading = $state(true)
	let streamingMap = $state(new Map<string, StreamEntry>())
	let editingConfig = $state(false)
	let configSaving = $state(false)
	let configError = $state<string | null>(null)
	let configSaved = $state(false)
	let draftSystemPrompt = $state('')
	let draftModel = $state('')

	// Wave 3 #13 phase 4 — per-agent hook bindings draft state.
	// Map of `event → comma-separated refs string` so the UI can edit text and convert on save.
	const HOOK_EVENTS = [
		'before_run', 'after_run', 'before_round', 'after_round', 'before_tool', 'after_tool',
		'on_compact', 'on_evaluator', 'on_subagent_spawn', 'on_approval_required',
		'on_user_question', 'on_run_failed', 'on_skill_loaded', 'on_tool_output_archived',
	] as const
	type HookEventName = (typeof HOOK_EVENTS)[number]
	let draftHookRefs = $state<Record<string, string>>({})

	let eventSource: EventSource | null = null
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null

	function liveStream(): StreamEntry | undefined {
		if (!data) return undefined
		for (const entry of streamingMap.values()) {
			if (entry.agentId === data.agent.id) return entry
		}
		return undefined
	}

	const liveEntry = $derived(liveStream())

	const maxToolCount = $derived(
		data?.toolUsage.length ? Math.max(...data.toolUsage.map((t) => t.count)) : 1,
	)

	onMount(() => {
		void loadData()
		connectMonitor()
	})

	onDestroy(() => {
		eventSource?.close()
		if (reconnectTimer) clearTimeout(reconnectTimer)
	})

	function readAgentHooks(agent: AgentData['agent']): Record<string, string[]> {
		const config = (agent.config ?? null) as { hooks?: unknown } | null
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

	function syncDraftFromAgent(agent: AgentData['agent']) {
		draftSystemPrompt = agent.systemPrompt
		draftModel = agent.model
		// Convert `event → string[]` into `event → comma-separated string` for the textbox UI.
		const persistedHooks = readAgentHooks(agent)
		draftHookRefs = Object.fromEntries(
			HOOK_EVENTS.map((event) => [event, persistedHooks[event]?.join(', ') ?? '']),
		)
	}

	async function loadData() {
		loading = true
		const result = await getAgent(agentId)
		data = result ?? null
		if (data) syncDraftFromAgent(data.agent)
		loading = false
	}

	function startEditConfig() {
		if (!data) return
		syncDraftFromAgent(data.agent)
		configError = null
		configSaved = false
		editingConfig = true
	}

	function cancelEditConfig() {
		editingConfig = false
		configError = null
		configSaved = false
		if (!data) return
		syncDraftFromAgent(data.agent)
	}

	async function saveConfig() {
		if (!data) return
		const systemPrompt = draftSystemPrompt.trim()
		const model = draftModel.trim()
		if (!systemPrompt) {
			configError = 'System prompt cannot be empty.'
			return
		}
		if (!model) {
			configError = 'Model cannot be empty.'
			return
		}

		configSaving = true
		configError = null
		configSaved = false
		try {
			// Convert `event → comma-separated string` back to `event → string[]`. Empty entries
			// drop out so updateAgentRecord can clear them via its empty-array semantics.
			const hooks: Record<string, string[]> = {}
			for (const [event, raw] of Object.entries(draftHookRefs)) {
				const refs = raw.split(',').map((r) => r.trim()).filter((r) => r.length > 0)
				if (refs.length > 0) hooks[event] = refs
			}
			const updated = await updateAgentCommand({
				agentId: data.agent.id,
				systemPrompt,
				model,
				hooks,
			})
			if (!updated) {
				configError = 'Failed to save agent configuration.'
				return
			}
			data = {
				...data,
				agent: updated,
			}
			editingConfig = false
			configSaved = true
		} catch (error) {
			configError = error instanceof Error ? error.message : 'Failed to save agent configuration.'
		} finally {
			configSaving = false
		}
	}

	function connectMonitor() {
		eventSource?.close()
		eventSource = new EventSource('/api/agents/monitor')
		eventSource.onmessage = (e) => {
			const streams: StreamEntry[] = JSON.parse(e.data as string)
			const next = new Map<string, StreamEntry>()
			for (const s of streams) next.set(s.conversationId, s)
			streamingMap = next
		}
		eventSource.onerror = () => {
			eventSource?.close()
			reconnectTimer = setTimeout(connectMonitor, 3000)
		}
	}
</script>

<div class="flex h-full min-h-0 flex-col">
	<PageHeader
		title={data?.agent.name ?? 'Agent'}
		crumbs={[{ label: 'Agents', href: '/agents' }]}
		backHref="/agents"
		subtitle={data ? `${data.agent.role}` : ''}
		live={!!liveEntry}
	>
		{#snippet chips()}
			{#if data}
				<span class="console-chip {data.agent.status === 'active' ? 'is-run' : ''}">{data.agent.status}</span>
				{#if liveEntry}
					<span class="console-chip is-run">
						<span class="pulse-dot"></span>
						live
					</span>
				{/if}
			{/if}
		{/snippet}
	</PageHeader>

	<div class="min-h-0 flex-1 overflow-y-auto px-3 py-3 tablet:px-4 desktop:px-4 desktop:py-4">

{#if loading}
	<div class="flex justify-center py-20">
		<span class="loading loading-spinner loading-lg text-primary"></span>
	</div>
{:else if !data}
	<div class="py-20 text-center">
		<p class="text-sm text-base-content/50">Agent not found.</p>
		<a class="btn btn-ghost btn-sm mt-4" href="/agents">← Back to agents</a>
	</div>
{:else}
	{@const color = agentColor(data.agent.id)}
	{@const live = liveEntry}

	<section class="space-y-5">

		<!-- ── Hero card ────────────────────────────────────────────────── -->
		<div class="relative overflow-hidden rounded-2xl border border-base-300 bg-base-100">
			<!-- Background gradient blob -->
			<div class="pointer-events-none absolute inset-0 bg-gradient-to-br {color.gradFrom} {color.gradTo} opacity-60"></div>

			<!-- Shimmer bar when streaming -->
			{#if live}
				<div class="relative h-[3px] w-full overflow-hidden bg-primary/30">
					<div class="shimmer-bar absolute inset-y-0 w-1/2 bg-gradient-to-r from-transparent via-primary to-transparent"></div>
				</div>
			{/if}

			<div class="relative flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:gap-5">
				<!-- Avatar -->
				<div class="relative shrink-0">
					<div
						class="flex h-20 w-20 items-center justify-center rounded-3xl ring-2 {color.ring} {color.bg} {color.text} text-2xl font-bold tracking-wide"
					>
						{agentInitials(data.agent.name)}
					</div>
					{#if live}
						<span class="absolute -bottom-1 -right-1 h-4 w-4 animate-pulse rounded-full border-2 border-base-100 bg-primary shadow-[0_0_10px_oklch(var(--p)/0.8)]"></span>
					{:else}
						<span
							class="absolute -bottom-1 -right-1 h-4 w-4 rounded-full border-2 border-base-100
								{data.agent.status === 'active' ? 'bg-success' : data.agent.status === 'paused' ? 'bg-warning' : 'bg-base-content/20'}"
						></span>
					{/if}
				</div>

				<!-- Name / role / badges -->
				<div class="min-w-0 flex-1">
					<div class="flex flex-wrap items-start gap-2">
						<h1 class="text-2xl font-bold leading-tight">{data.agent.name}</h1>
						<span
							class="badge badge-sm mt-1 {data.agent.status === 'active' ? 'badge-success' : data.agent.status === 'paused' ? 'badge-warning' : 'badge-ghost'}"
						>{data.agent.status}</span>
						{#if live}
							<span class="badge badge-sm badge-primary mt-1 gap-1">
								<span class="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current"></span>
								Live
							</span>
						{/if}
					</div>
					<p class="mt-1 text-sm text-base-content/65">{data.agent.role}</p>
					<p class="mt-0.5 font-mono text-xs text-base-content/40">{modelShortName(data.agent.model)}</p>
				</div>

				<!-- Right: last active -->
				<div class="shrink-0 text-right text-sm text-base-content/55">
					<p class="text-xs uppercase tracking-wide">Last active</p>
					<p class="font-semibold">{relativeTime(data.conversations[0]?.updatedAt)}</p>
				</div>
			</div>
		</div>

		<!-- ── Live session banner ───────────────────────────────────── -->
		{#if live}
			<div class="card card-body bg-primary/8 border-primary/30 rounded-2xl border p-4">
				<div class="mb-2 flex items-center justify-between gap-2">
					<div class="flex items-center gap-2">
						<span class="inline-block h-2 w-2 animate-pulse rounded-full bg-primary"></span>
						<span class="text-sm font-semibold text-primary">Currently streaming</span>
					</div>
					<a href="/chat/{live.conversationId}" class="btn btn-xs btn-primary">Watch live →</a>
				</div>
				<p class="line-clamp-2 break-words text-xs leading-relaxed text-base-content/70">
					{live.delta.length > 500 ? '…' + live.delta.slice(-500) : live.delta}
				</p>
				<span class="cursor-blink mt-1 inline-block h-3 w-[2px] translate-y-0.5 bg-primary align-middle"></span>
			</div>
		{/if}

		<!-- ── Stats grid ────────────────────────────────────────────── -->
		<AgentStatsGrid stats={data.stats} lastActiveAt={data.conversations[0]?.updatedAt ?? null} />

		<!-- ── Two-col: tool usage + automations ────────────────────── -->
		<div class="grid gap-4 lg:grid-cols-2">
			<!-- Tool usage -->
			<ContentPanel>
				{#snippet header()}
					<h2 class="font-semibold">Tool usage</h2>
				{/snippet}
				{#if data.toolUsage.length === 0}
					<p class="py-4 text-center text-sm text-base-content/40">No tool calls yet.</p>
				{:else}
					<div class="space-y-2.5">
						{#each data.toolUsage as tool (tool.name)}
							<div class="flex items-center gap-3">
								<span class="w-36 shrink-0 truncate font-mono text-xs text-base-content/70">{tool.name}</span>
								<div class="flex flex-1 items-center gap-2">
									<div class="h-2 flex-1 overflow-hidden rounded-full bg-base-200">
										<div
											class="h-full rounded-full bg-primary/70 transition-all duration-500"
											style="width: {Math.round((tool.count / maxToolCount) * 100)}%"
										></div>
									</div>
									<span class="w-8 text-right text-xs font-medium tabular-nums text-base-content/60">{tool.count}</span>
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</ContentPanel>

			<!-- Automations -->
			<ContentPanel>
				{#snippet header()}
					<h2 class="font-semibold">Automations</h2>
				{/snippet}
				{#if data.automations.length === 0}
					<p class="py-4 text-center text-sm text-base-content/40">No automations configured.</p>
				{:else}
					<div class="space-y-2">
						{#each data.automations as auto (auto.id)}
							<div class="rounded-xl border border-base-300/60 bg-base-200/25 p-3">
								<div class="flex items-start justify-between gap-2">
									<div class="min-w-0 flex-1">
										<p class="truncate text-sm font-medium">{auto.description}</p>
										<div class="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-base-content/55">
											<span class="badge badge-xs font-mono">{describeSchedule(auto.cronExpression)}</span>
											<span class="badge badge-xs {auto.enabled ? 'badge-success' : 'badge-ghost'}">
												{auto.enabled ? 'enabled' : 'disabled'}
											</span>
										</div>
									</div>
								</div>
								<div class="mt-2 grid grid-cols-2 gap-x-4 text-xs text-base-content/45">
									<span>Last: {relativeTime(auto.lastRunAt)}</span>
									<span>Next: {auto.nextRunAt ? relativeTime(auto.nextRunAt) : '—'}</span>
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</ContentPanel>
		</div>

		<!-- ── Agent configuration ──────────────────────────────────── -->
		<ContentPanel>
			{#snippet header()}
				<div class="flex min-w-0 flex-1 items-center justify-between gap-2">
					<h2 class="font-semibold">Agent configuration</h2>
					<div class="flex items-center gap-2">
						{#if configSaved}
							<span class="text-xs text-success">Saved</span>
						{/if}
						{#if editingConfig}
							<button class="btn btn-xs btn-ghost" onclick={cancelEditConfig} disabled={configSaving}>Cancel</button>
							<button class="btn btn-xs btn-primary" onclick={saveConfig} disabled={configSaving}>
								{configSaving ? 'Saving…' : 'Save'}
							</button>
						{:else}
							<button class="btn btn-xs btn-ghost" onclick={startEditConfig}>Edit</button>
						{/if}
					</div>
				</div>
			{/snippet}

			{#if configError}
				<div class="alert alert-error mb-3 py-2 text-xs">{configError}</div>
			{/if}

			<div class="mb-4">
				<p class="text-xs font-semibold uppercase tracking-wide text-base-content/45">Model</p>
				{#if editingConfig}
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
					<p class="mt-1 font-mono text-xs text-base-content/65">{data.agent.model}</p>
				{/if}
			</div>

			<div class="mb-2 border-t border-base-300/70"></div>

			<div class="mb-2 flex items-center justify-between gap-2">
				<p class="text-xs font-semibold uppercase tracking-wide text-base-content/45">System prompt</p>
				<a class="link link-primary text-[11px]" href="/agents/{agentId}/identity">Open identity editor →</a>
			</div>
			{#if editingConfig}
				<textarea
					class="textarea textarea-bordered min-h-52 w-full text-xs leading-relaxed"
					bind:value={draftSystemPrompt}
				></textarea>
				<p class="mt-1 text-right text-[11px] text-base-content/45">{draftSystemPrompt.length} chars</p>
			{:else}
				<pre class="whitespace-pre-wrap text-xs leading-relaxed text-base-content/70">{data.agent.systemPrompt}</pre>
			{/if}

			<div class="mb-2 mt-4 border-t border-base-300/70"></div>

			<p class="mb-1 text-xs font-semibold uppercase tracking-wide text-base-content/45">Hook bindings</p>
			<p class="mb-2 text-[11px] leading-snug text-base-content/55">
				Bind opt-in built-in hook handlers OR (future) skill slugs to lifecycle events for this agent only. Globally-registered handlers (activity emit, etc.) fire automatically — bindings here are additive. <a href="/settings/hooks" class="link link-hover">View invocation log</a>.
			</p>
			{#if editingConfig}
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
				{@const persistedHooks = readAgentHooks(data.agent)}
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

		<!-- ── Session history ───────────────────────────────────────── -->
		<AgentSessionsList conversations={data.conversations} />
	</section>
{/if}
	</div>
</div>

<style>
	.shimmer-bar {
		animation: shimmer 1.6s ease-in-out infinite;
	}
	@keyframes shimmer {
		0% { transform: translateX(-100%); }
		100% { transform: translateX(300%); }
	}
	.cursor-blink {
		animation: blink 1s step-end infinite;
	}
	@keyframes blink {
		0%, 100% { opacity: 1; }
		50% { opacity: 0; }
	}
</style>

