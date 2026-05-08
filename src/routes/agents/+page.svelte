<svelte:head><title>Agents | AgentStudio</title></svelte:head>

<script lang="ts">
	import { onMount, onDestroy } from 'svelte'
	import { listAgents } from '$lib/agents'
	import { formatCost } from '$lib/agents/agent-format'
	import PageHeader from '$lib/ui/PageHeader.svelte'
	import { relativeTime as relativeTimeBase } from '$lib/util/relative-time'

	const relativeTime = (date: Date | string | null) =>
		relativeTimeBase(date, { style: 'capitalized' })

	type AgentRow = Awaited<ReturnType<typeof listAgents>>[number]
	type StreamEntry = { conversationId: string; agentId: string; delta: string }

	let agents = $state<AgentRow[]>([])
	let loading = $state(true)
	let streamingMap = $state(new Map<string, StreamEntry>())
	let sortMode = $state<'last_active' | 'sessions' | 'cost'>('last_active')

	let eventSource: EventSource | null = null
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null

	// ── Deterministic agent color from ID ──────────────────────────────────
	const COLORS = [
		{ ring: 'ring-primary/40', bg: 'bg-primary/15', text: 'text-primary' },
		{ ring: 'ring-secondary/40', bg: 'bg-secondary/15', text: 'text-secondary' },
		{ ring: 'ring-accent/40', bg: 'bg-accent/15', text: 'text-accent' },
		{ ring: 'ring-info/40', bg: 'bg-info/15', text: 'text-info' },
		{ ring: 'ring-success/40', bg: 'bg-success/15', text: 'text-success' },
		{ ring: 'ring-warning/40', bg: 'bg-warning/15', text: 'text-warning' },
	]

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

	// relativeTime defined above using $lib/util/relative-time with capitalized style.
	// formatCost imported from $lib/agents/agent-format

	function modelShortName(model: string) {
		return model.split('/').pop() ?? model
	}

	function streamForAgent(agentId: string): StreamEntry | undefined {
		for (const entry of streamingMap.values()) {
			if (entry.agentId === agentId) return entry
		}
		return undefined
	}

	const activeAgentIds = $derived([...streamingMap.values()].map((e) => e.agentId))

	const sortedAgents = $derived.by(() => {
		const list = [...agents]
		if (sortMode === 'sessions') return list.sort((a, b) => b.sessionCount - a.sessionCount)
		if (sortMode === 'cost') return list.sort((a, b) => parseFloat(b.totalCost) - parseFloat(a.totalCost))
		return list.sort((a, b) => {
			const ta = a.lastActiveAt ? new Date(a.lastActiveAt).getTime() : 0
			const tb = b.lastActiveAt ? new Date(b.lastActiveAt).getTime() : 0
			return tb - ta
		})
	})

	onMount(() => {
		void loadAgents()
		connectMonitor()
	})

	onDestroy(() => {
		eventSource?.close()
		if (reconnectTimer) clearTimeout(reconnectTimer)
	})

	async function loadAgents() {
		loading = true
		agents = await listAgents()
		loading = false
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
		title="Agents"
		subtitle={`${agents.length} agent${agents.length !== 1 ? 's' : ''}${activeAgentIds.length > 0 ? ` • ${activeAgentIds.length} streaming` : ''}`}
		live={activeAgentIds.length > 0}
	>
		{#snippet chips()}
			<span class="console-chip">{agents.length} total</span>
			{#if activeAgentIds.length > 0}
				<span class="console-chip is-run">
					<span class="pulse-dot"></span>
					{activeAgentIds.length} streaming
				</span>
			{/if}
		{/snippet}
		{#snippet actions()}
			<div class="join">
				<button
					class="btn join-item btn-xs {sortMode === 'last_active' ? 'btn-neutral' : 'btn-ghost'}"
					onclick={() => (sortMode = 'last_active')}
				>Recent</button>
				<button
					class="btn join-item btn-xs {sortMode === 'sessions' ? 'btn-neutral' : 'btn-ghost'}"
					onclick={() => (sortMode = 'sessions')}
				>Sessions</button>
				<button
					class="btn join-item btn-xs {sortMode === 'cost' ? 'btn-neutral' : 'btn-ghost'}"
					onclick={() => (sortMode = 'cost')}
				>Cost</button>
			</div>
		{/snippet}
	</PageHeader>

	<div class="min-h-0 flex-1 overflow-y-auto px-3 py-3 tablet:px-4 desktop:px-4 desktop:py-4 space-y-5">
	<!-- ── Grid ───────────────────────────────────────────────────────────── -->
	{#if loading}
		<div class="flex justify-center py-16">
			<span class="loading loading-spinner loading-lg text-primary"></span>
		</div>
	{:else if sortedAgents.length === 0}
		<div class="rounded-2xl border border-dashed border-base-300 py-16 text-center text-sm text-base-content/50">
			No agents yet. Ask the orchestrator to create one.
		</div>
	{:else}
		<div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
			{#each sortedAgents as agent (agent.id)}
				{@const color = agentColor(agent.id)}
				{@const streaming = streamForAgent(agent.id)}
				{@const isStreaming = !!streaming}
				<article
					class="group relative flex flex-col overflow-hidden bg-base-100 border-base-300 rounded-2xl border transition-all duration-200 hover:border-base-content/20 hover:shadow-xl hover:shadow-base-content/5"
				>
					<!-- Animated top accent bar -->
					<div class="relative h-[3px] w-full overflow-hidden {isStreaming ? 'bg-primary/30' : 'bg-base-300/50'}">
						{#if isStreaming}
							<div class="shimmer-bar absolute inset-y-0 w-1/2 bg-gradient-to-r from-transparent via-primary to-transparent"></div>
						{/if}
					</div>

					<div class="flex flex-1 flex-col gap-3 p-4">
						<!-- Avatar + Name + Status -->
						<div class="flex items-start gap-3">
							<div class="relative shrink-0">
								<div
									class="flex h-12 w-12 items-center justify-center rounded-2xl ring-2 {color.ring} {color.bg} {color.text} text-sm font-bold tracking-wide"
								>
									{agentInitials(agent.name)}
								</div>
								<span
									class="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-base-100
										{isStreaming ? 'animate-pulse bg-primary' : agent.status === 'active' ? 'bg-success' : agent.status === 'paused' ? 'bg-warning' : 'bg-base-content/20'}"
								></span>
							</div>

							<div class="min-w-0 flex-1">
								<h2 class="truncate font-semibold leading-snug">{agent.name}</h2>
								<p class="truncate text-xs text-base-content/55">{agent.role}</p>
								<p class="mt-0.5 font-mono text-[10px] text-base-content/35">{modelShortName(agent.model)}</p>
							</div>

							<span
								class="badge badge-sm shrink-0 {agent.status === 'active' ? 'badge-success' : agent.status === 'paused' ? 'badge-warning' : 'badge-ghost'}"
							>{agent.status}</span>
						</div>

						<!-- Stats row -->
						<div class="flex items-center gap-3 text-xs text-base-content/55">
							<span class="flex items-center gap-1.5">
								<svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
								</svg>
								{agent.sessionCount} sessions
							</span>
							<span class="flex items-center gap-1.5">
								<svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<circle cx="12" cy="12" r="10"/><path d="M12 6v12M9 9h4.5a1.5 1.5 0 0 1 0 3H9m0 3h4.5a1.5 1.5 0 0 1 0 3H9"/>
								</svg>
								{formatCost(agent.totalCost)}
							</span>
							<span class="ml-auto font-medium">{relativeTime(agent.lastActiveAt)}</span>
						</div>

						<!-- Live preview or system prompt -->
						<div class="flex-1">
							{#if isStreaming && streaming}
								<div class="rounded-xl border border-primary/25 bg-primary/6 p-3">
									<div class="mb-2 flex items-center gap-1.5">
										<span class="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary"></span>
										<span class="text-[10px] font-semibold uppercase tracking-widest text-primary/70">Streaming live</span>
									</div>
									<p class="line-clamp-3 break-all text-[11px] leading-relaxed text-base-content/70">
										{streaming.delta.length > 400 ? '…' + streaming.delta.slice(-400) : streaming.delta}
									</p>
									<span class="cursor-blink mt-0.5 inline-block h-3 w-[2px] translate-y-0.5 bg-primary align-middle"></span>
								</div>
							{:else}
								<div class="rounded-xl border border-base-300/60 bg-base-200/25 p-3">
									<p class="mb-1 text-[10px] font-semibold uppercase tracking-wide text-base-content/35">System prompt</p>
									<p class="line-clamp-3 text-[11px] leading-relaxed text-base-content/60">{agent.systemPrompt}</p>
								</div>
							{/if}
						</div>

						<!-- Footer -->
						<div class="flex items-center gap-1.5">
							<a class="btn btn-xs btn-outline flex-1" href="/agents/{agent.id}">View details</a>
							{#if isStreaming && streaming}
								<a class="btn btn-xs btn-primary shrink-0" href="/chat/{streaming.conversationId}">Watch live →</a>
							{/if}
						</div>
					</div>
				</article>
			{/each}
		</div>
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

