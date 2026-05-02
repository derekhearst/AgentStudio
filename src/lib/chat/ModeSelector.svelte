<script lang="ts">
	type ChatMode = 'chat' | 'research' | 'plan' | 'agent'

	const MODE_OPTIONS: Array<{ value: ChatMode; label: string; description: string }> = [
		{ value: 'chat', label: 'Chat', description: 'Conversational and collaborative.' },
		{ value: 'research', label: 'Research', description: 'Skeptical investigator; cites sources.' },
		{ value: 'plan', label: 'Plan', description: 'Proposes structured plans before acting.' },
		{ value: 'agent', label: 'Agent', description: 'Executes autonomously with minimal interruption.' },
	]

	let {
		mode = 'chat',
		busy = false,
		onModeChange,
	}: {
		mode?: ChatMode
		busy?: boolean
		onModeChange?: ((mode: ChatMode) => Promise<void> | void) | undefined
	} = $props()

	let menuOpen = $state(false)
	const selected = $derived(MODE_OPTIONS.find((o) => o.value === mode) ?? MODE_OPTIONS[0])

	async function pick(next: ChatMode) {
		menuOpen = false
		if (next === mode) return
		await onModeChange?.(next)
	}
</script>

<div class="dropdown dropdown-top">
	<button
		type="button"
		class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-base-content/85 hover:bg-base-200 disabled:cursor-not-allowed disabled:opacity-50"
		title={`Mode: ${selected.label} — ${selected.description}`}
		aria-label="Conversation mode"
		aria-expanded={menuOpen}
		disabled={busy}
		onclick={() => {
			menuOpen = !menuOpen
		}}
	>
		<span class="truncate">{selected.label}</span>
		<span class="opacity-70">▾</span>
	</button>
	{#if menuOpen}
		<ul class="menu dropdown-content z-30 mb-2 w-56 rounded-box border border-base-300 bg-base-100 p-1 shadow-xl">
			{#each MODE_OPTIONS as option (option.value)}
				<li>
					<button
						type="button"
						class:active={option.value === mode}
						class="flex flex-col items-start gap-0.5"
						onclick={() => pick(option.value)}
					>
						<span class="text-sm font-medium">{option.label}</span>
						<span class="text-xs text-base-content/60">{option.description}</span>
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</div>
