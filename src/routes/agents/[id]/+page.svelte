<svelte:head><title>{data?.agent.name ?? 'Agent'} | AgentStudio</title></svelte:head>

<script lang="ts">
	import { page } from '$app/state'
	import { onMount, onDestroy } from 'svelte'
	import { getAgent, updateAgentCommand } from '$lib/agents'
	import ModelSelector from '$lib/models/ModelSelector.svelte'
	import ContentPanel from '$lib/ui/ContentPanel.svelte'

	type AgentData = NonNullable<Awaited<ReturnType<typeof getAgent>>>
	type StreamEntry = { conversationId: string; agentId: string; delta: string }

	const agentId = $derived(page.params.id ?? '')
	let data = $state<AgentData | null>(null)
	let loading = $state(true)
	let streamingMap = $state(new Map<string, StreamEntry>())
	let showAllConversations = $state(false)
	let editingConfig = $state(false)
	let configSaving = $state(false)
	let configError = $state<string | null>(null)
	let configSaved = $state(false)
	let draftSystemPrompt = $state('')
	let draftModel = $state('')

	let eventSource: EventSource | null = null
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null

	// ── Color helpers ──────────────────────────────────────────────────────
	const COLORS = [
		{ ring: 'ring-primary/40', bg: 'bg-primary/15', text: 'text-primary', accent: 'border-primary', gradFrom: 'from-primary/20', gradTo: 'to-primary/5' },
		{ ring: 'ring-secondary/40', bg: 'bg-secondary/15', text: 'text-secondary', accent: 'border-secondary', gradFrom: 'from-secondary/20', gradTo: 'to-secondary/5' },
		{ ring: 'ring-accent/40', bg: 'bg-accent/15', text: 'text-accent', accent: 'border-accent', gradFrom: 'from-accent/20', gradTo: 'to-accent/5' },
		{ ring: 'ring-info/40', bg: 'bg-info/15', text: 'text-info', accent: 'border-info', gradFrom: 'from-info/20', gradTo: 'to-info/5' },
		{ ring: 'ring-success/40', bg: 'bg-success/15', text: 'text-success', accent: 'border-success', gradFrom: 'from-success/20', gradTo: 'to-success/5' },
		{ ring: 'ring-warning/40', bg: 'bg-warning/15', text: 'text-warning', accent: 'border-warning', gradFrom: 'from-warning/20', gradTo: 'to-warning/5' },
	]

	// Model colors for session left-border
	const MODEL_COLORS: Record<string, string> = {
		claude: 'border-l-purple-500/50',
		gpt: 'border-l-green-500/50',
		gemini: 'border-l-blue-500/50',
		mistral: 'border-l-orange-500/50',
		llama: 'border-l-pink-500/50',
	}

	function agentColor(id: string) {
		return COLORS[id.charCodeAt(0) % COLORS.length]
	}

	function agentInitials(name: string) {
		return name
			.split(/\s+/)
			.map((w) => w[0] ?? '')
			.join('')
			.slice(0, 2)
			.toUpperCase()
	}

	function modelColor(model: string | null | undefined) {
		if (!model) return 'border-l-base-300'
		const key = Object.keys(MODEL_COLORS).find((k) => model.toLowerCase().includes(k))
		return key ? MODEL_COLORS[key] : 'border-l-base-300'
	}

	function modelShortName(model: string) {
		return model.split('/').pop() ?? model
	}

	function relativeTime(date: Date | string | null | undefined) {
		if (!date) return 'Never'
		const d = typeof date === 'string' ? new Date(date) : date
		const diff = Date.now() - d.getTime()
		if (diff < 60_000) return 'Just now'
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
		if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
		return `${Math.floor(diff / 86_400_000)}d ago`
	}

	function formatDate(date: Date | string | null | undefined) {
		if (!date) return '—'
		return new Date(typeof date === 'string' ? date : date).toLocaleDateString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
		})
	}

	function formatCost(cost: string | number | null | undefined) {
		const n = typeof cost === 'string' ? parseFloat(cost) : (cost ?? 0)
		if (n === 0) return '$0.00'
		return n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`
	}

	function formatTokens(n: number | null | undefined) {
		if (!n) return '0'
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
		if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
		return String(n)
	}

	function liveStream(): StreamEntry | undefined {
		if (!data) return undefined
		for (const entry of streamingMap.values()) {
			if (entry.agentId === data.agent.id) return entry
		}
		return undefined
	}

	const liveEntry = $derived(liveStream())

	const visibleConversations = $derived(
		showAllConversations ? data?.conversations ?? [] : (data?.conversations ?? []).slice(0, 10),
	)

	const maxToolCount = $derived(
		data?.toolUsage.length ? Math.max(...data.toolUsage.map((t) => t.count)) : 1,
	)

	// Cron expression human-readable
	function describeSchedule(cron: string) {
		const parts = cron.split(' ')
		if (parts.length !== 5) return cron
		const [min, hour] = parts
		if (min === '0' && hour === '*') return 'Every hour'
		if (min === '0' && hour === '0') return 'Daily midnight'
		if (min === '*/30') return 'Every 30 minutes'
		if (min === '*/15') return 'Every 15 minutes'
		if (min === '*/5') return 'Every 5 minutes'
		return cron
	}

	onMount(() => {
		void loadData()
		connectMonitor()
	})

	onDestroy(() => {
		eventSource?.close()
		if (reconnectTimer) clearTimeout(reconnectTimer)
	})

	async function loadData() {
		loading = true
		const result = await getAgent(agentId)
		data = result ?? null
		if (data) {
			draftSystemPrompt = data.agent.systemPrompt
			draftModel = data.agent.model
		}
		loading = false
	}

	function startEditConfig() {
		if (!data) return
		draftSystemPrompt = data.agent.systemPrompt
		draftModel = data.agent.model
		configError = null
		configSaved = false
		editingConfig = true
	}

	function cancelEditConfig() {
		editingConfig = false
		configError = null
		configSaved = false
		if (!data) return
		draftSystemPrompt = data.agent.systemPrompt
		draftModel = data.agent.model
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
			const updated = await updateAgentCommand({
				agentId: data.agent.id,
				systemPrompt,
				model,
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
		<!-- ── Back nav ─────────────────────────────────────────────────── -->
		<a class="btn btn-sm btn-ghost -ml-1 w-fit" href="/agents">← All agents</a>

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
			<div class="rounded-2xl border border-primary/30 bg-primary/8 p-4">
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
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
			<!-- Sessions -->
			<div class="rounded-2xl border border-base-300 bg-base-100 p-4">
				<div class="mb-2 flex h-8 w-8 items-center justify-center rounded-xl bg-primary/15 text-primary">
					<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
					</svg>
				</div>
				<p class="text-2xl font-bold tabular-nums">{data.stats.sessionCount}</p>
				<p class="mt-0.5 text-xs text-base-content/50">Sessions</p>
			</div>

			<!-- Total cost -->
			<div class="rounded-2xl border border-base-300 bg-base-100 p-4">
				<div class="mb-2 flex h-8 w-8 items-center justify-center rounded-xl bg-success/15 text-success">
					<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<circle cx="12" cy="12" r="10"/><path d="M12 6v12M9 9h4.5a1.5 1.5 0 0 1 0 3H9m0 3h4.5a1.5 1.5 0 0 1 0 3H9"/>
					</svg>
				</div>
				<p class="text-2xl font-bold tabular-nums">{formatCost(data.stats.totalCost)}</p>
				<p class="mt-0.5 text-xs text-base-content/50">Total cost</p>
			</div>

			<!-- Total tokens -->
			<div class="rounded-2xl border border-base-300 bg-base-100 p-4">
				<div class="mb-2 flex h-8 w-8 items-center justify-center rounded-xl bg-info/15 text-info">
					<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
					</svg>
				</div>
				<p class="text-2xl font-bold tabular-nums">{formatTokens(data.stats.totalTokens)}</p>
				<p class="mt-0.5 text-xs text-base-content/50">Tokens</p>
			</div>

			<!-- Avg cost/session -->
			<div class="rounded-2xl border border-base-300 bg-base-100 p-4">
				<div class="mb-2 flex h-8 w-8 items-center justify-center rounded-xl bg-warning/15 text-warning">
					<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
					</svg>
				</div>
				<p class="text-2xl font-bold tabular-nums">{formatCost(data.stats.avgCostPerSession)}</p>
				<p class="mt-0.5 text-xs text-base-content/50">Avg/session</p>
			</div>

			<!-- Avg first token -->
			<div class="rounded-2xl border border-base-300 bg-base-100 p-4">
				<div class="mb-2 flex h-8 w-8 items-center justify-center rounded-xl bg-secondary/15 text-secondary">
					<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
					</svg>
				</div>
				<p class="text-2xl font-bold tabular-nums">
					{data.stats.avgTtftMs !== null ? `${data.stats.avgTtftMs}ms` : '—'}
				</p>
				<p class="mt-0.5 text-xs text-base-content/50">Avg first token</p>
			</div>

			<!-- Last active -->
			<div class="rounded-2xl border border-base-300 bg-base-100 p-4">
				<div class="mb-2 flex h-8 w-8 items-center justify-center rounded-xl bg-accent/15 text-accent">
					<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
					</svg>
				</div>
				<p class="truncate text-xl font-bold">{relativeTime(data.conversations[0]?.updatedAt)}</p>
				<p class="mt-0.5 text-xs text-base-content/50">Last active</p>
			</div>
		</div>

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

			<p class="mb-2 text-xs font-semibold uppercase tracking-wide text-base-content/45">System prompt</p>
			{#if editingConfig}
				<textarea
					class="textarea textarea-bordered min-h-52 w-full text-xs leading-relaxed"
					bind:value={draftSystemPrompt}
				></textarea>
				<p class="mt-1 text-right text-[11px] text-base-content/45">{draftSystemPrompt.length} chars</p>
			{:else}
				<pre class="whitespace-pre-wrap text-xs leading-relaxed text-base-content/70">{data.agent.systemPrompt}</pre>
			{/if}
		</ContentPanel>

		<!-- ── Session history ───────────────────────────────────────── -->
		<ContentPanel>
			{#snippet header()}
				<div class="flex min-w-0 flex-1 items-center justify-between gap-2">
					<h2 class="font-semibold">Sessions</h2>
					<span class="badge badge-sm badge-ghost">{data?.conversations.length ?? 0}</span>
				</div>
			{/snippet}
			{#if data.conversations.length === 0}
				<p class="py-4 text-center text-sm text-base-content/40">No sessions yet.</p>
			{:else}
				<div class="space-y-2">
					{#each visibleConversations as chat (chat.id)}
						<a
							href="/chat/{chat.id}"
							class="flex items-center gap-3 rounded-xl border border-base-300/60 border-l-4 bg-base-200/20 p-3 transition-colors hover:bg-base-200/50 {modelColor(chat.model)}"
						>
							<div class="min-w-0 flex-1">
								<p class="truncate text-sm font-medium">{chat.title}</p>
								<div class="mt-0.5 flex items-center gap-2 text-xs text-base-content/50">
									<span>{formatDate(chat.updatedAt)}</span>
									{#if chat.messageCount > 0}
										<span>·</span>
										<span>{chat.messageCount} msgs</span>
									{/if}
								</div>
							</div>
							<div class="shrink-0 text-right text-xs text-base-content/50">
								<p class="tabular-nums">{formatTokens(chat.totalTokens)} tokens</p>
								<p class="tabular-nums">{formatCost(chat.totalCost)}</p>
							</div>
						</a>
					{/each}
				</div>

				{#if data.conversations.length > 10}
					<div class="mt-3 text-center">
						<button
							class="btn btn-sm btn-ghost"
							onclick={() => (showAllConversations = !showAllConversations)}
						>
							{showAllConversations
								? 'Show fewer'
								: `Show all ${data.conversations.length} sessions`}
						</button>
					</div>
				{/if}
			{/if}
		</ContentPanel>
	</section>
{/if}

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

