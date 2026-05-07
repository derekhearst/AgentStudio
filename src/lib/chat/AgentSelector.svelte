<script lang="ts">
	export type AgentChoice = {
		id: string
		name: string
		role: string
		builtinKey: string | null
		status?: string
	}

	let {
		agentId,
		agentChoices = [],
		busy = false,
		onAgentChange,
	}: {
		agentId?: string | null
		agentChoices?: AgentChoice[]
		busy?: boolean
		onAgentChange?: ((agentId: string) => Promise<void> | void) | undefined
	} = $props()

	let menuOpen = $state(false)

	const builtins = $derived(agentChoices.filter((a) => a.builtinKey != null))
	const custom = $derived(agentChoices.filter((a) => a.builtinKey == null))
	const selected = $derived(agentChoices.find((a) => a.id === agentId) ?? builtins[0] ?? agentChoices[0])

	async function pick(nextId: string) {
		menuOpen = false
		if (nextId === agentId) return
		await onAgentChange?.(nextId)
	}
</script>

<!-- On tablet+ we right-anchor to the trigger so the menu doesn't overflow the right edge.
     On mobile the trigger sits in the middle of a narrow composer toolbar and neither edge
     has enough clearance for a 256px menu, so the inner <ul> switches to a fixed bottom
     sheet (see below). -->
<div class="dropdown dropdown-top tablet:dropdown-end" class:dropdown-open={menuOpen}>
	<button
		type="button"
		class="btn btn-ghost btn-xs gap-1"
		title={selected ? `Agent: ${selected.name} — ${selected.role}` : 'Select agent'}
		aria-label="Conversation agent"
		aria-expanded={menuOpen}
		disabled={busy || agentChoices.length === 0}
		onclick={() => {
			menuOpen = !menuOpen
		}}
	>
		<span class="truncate">{selected?.name ?? 'Agent'}</span>
		<span class="opacity-70">▾</span>
	</button>
	{#if menuOpen}
		<ul
			class="menu dropdown-content bg-base-100 border-base-300 rounded-box z-30 border p-1 shadow-xl
				   max-tablet:!fixed max-tablet:!inset-x-2 max-tablet:!bottom-20 max-tablet:!top-auto max-tablet:!left-2 max-tablet:!right-2 max-tablet:!w-auto max-tablet:!max-w-none max-tablet:!mb-0
				   tablet:mb-2 tablet:w-64 tablet:max-w-[calc(100vw-1rem)]"
		>
			{#each builtins as option (option.id)}
				<li>
					<button
						type="button"
						class:menu-active={option.id === agentId}
						class="flex flex-col items-start gap-0.5"
						onclick={() => pick(option.id)}
					>
						<span class="text-sm font-medium">{option.name}</span>
						<span class="text-base-content/60 line-clamp-1 text-xs">{option.role}</span>
					</button>
				</li>
			{/each}
			{#if custom.length > 0}
				<li class="menu-title pt-2 text-[11px] uppercase tracking-wider text-base-content/50">
					Your agents
				</li>
				{#each custom as option (option.id)}
					<li>
						<button
							type="button"
							class:menu-active={option.id === agentId}
							class="flex flex-col items-start gap-0.5"
							onclick={() => pick(option.id)}
						>
							<span class="text-sm font-medium">{option.name}</span>
							<span class="text-base-content/60 line-clamp-1 text-xs">{option.role}</span>
						</button>
					</li>
				{/each}
			{/if}
			<li class="border-t border-base-300/60 mt-1 pt-1">
				<a href="/agents" class="text-xs text-base-content/70" onclick={() => (menuOpen = false)}>
					Manage agents →
				</a>
			</li>
		</ul>
	{/if}
</div>
