<script lang="ts">
	import { tick } from 'svelte'
	import { getAvailableModels } from '$lib/llm/models.remote'
	import type { ModelInfo } from '$lib/llm/models.server'

	interface Props {
		value?: string
		onchange?: (modelId: string) => void
		class?: string
		size?: 'xs' | 'sm' | 'default'
		variant?: 'default' | 'inline'
		showChevron?: boolean
		showBrowseBadge?: boolean
		requireInputModality?: string
	}

	let {
		value = 'anthropic/claude-sonnet-4',
		onchange,
		class: className = '',
		size = 'default',
		variant = 'default',
		showChevron = true,
		showBrowseBadge = true,
		requireInputModality,
	}: Props = $props()

	let models: ModelInfo[] = $state.raw([])
	$effect(() => {
		getAvailableModels().then((m) => (models = m))
	})

	// Move the modal element out of the composer's stacking context (the composer wrapper has
	// `view-transition-name`, which creates a stacking context that traps `position: fixed`
	// children below later-painted siblings like the chat-list aside).
	function portal(node: HTMLElement) {
		document.body.appendChild(node)
		return {
			destroy() {
				node.remove()
			},
		}
	}
	let search = $state('')
	let open = $state(false)
	let settingsOpen = $state(false)
	let inputEl: HTMLInputElement | undefined = $state()
	let settingsRef: HTMLDivElement | undefined = $state()

	function openModal() {
		open = true
	}

	function closeModal() {
		open = false
		search = ''
	}

	function closeSettings() {
		settingsOpen = false
	}

	type SortKey = 'name' | 'price' | 'context' | 'newest' | 'oldest'
	let sortBy: SortKey = $state('name')
	let selectedInputMods: Set<string> = $state(new Set())
	let selectedOutputMods: Set<string> = $state(new Set())
	let groupByCreator = $state(false)

	function toggleIn(cap: string) {
		const next = new Set(selectedInputMods)
		if (next.has(cap)) next.delete(cap)
		else next.add(cap)
		selectedInputMods = next
	}

	function toggleOut(cap: string) {
		const next = new Set(selectedOutputMods)
		if (next.has(cap)) next.delete(cap)
		else next.add(cap)
		selectedOutputMods = next
	}

	const activeFilterCount = $derived(selectedInputMods.size + selectedOutputMods.size + (groupByCreator ? 1 : 0) + (sortBy !== 'name' ? 1 : 0))

	$effect(() => {
		if (!open) {
			settingsOpen = false
			return
		}

		const handleKeydown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				if (settingsOpen) {
					closeSettings()
				} else {
					closeModal()
				}
			}
		}

		const handleClickOutside = (e: MouseEvent) => {
			if (settingsOpen && settingsRef && !settingsRef.contains(e.target as Node)) {
				closeSettings()
			}
		}

		window.addEventListener('keydown', handleKeydown)
		window.addEventListener('mousedown', handleClickOutside)
		void tick().then(() => inputEl?.focus())

		return () => {
			window.removeEventListener('keydown', handleKeydown)
			window.removeEventListener('mousedown', handleClickOutside)
		}
	})

	const sizeClass = $derived(
		size === 'xs' ? 'input-xs text-xs' : size === 'sm' ? 'input-sm text-sm' : ''
	)

	const isInline = $derived(variant === 'inline')

	const gridSizeClass = $derived(
		size === 'xs' ? 'text-xs' : size === 'sm' ? 'text-sm' : ''
	)

	const availableInputMods = $derived.by(() => {
		const caps = new Set<string>()
		for (const m of models) {
			for (const mod of m.inputModalities ?? []) caps.add(mod)
		}
		return Array.from(caps).sort()
	})

	const availableOutputMods = $derived.by(() => {
		const caps = new Set<string>()
		for (const m of models) {
			for (const mod of m.outputModalities ?? []) caps.add(mod)
		}
		return Array.from(caps).sort()
	})

	const filtered = $derived.by(() => {
		let result = models

		if (requireInputModality) {
			result = result.filter((m) => (m.inputModalities ?? []).includes(requireInputModality))
		}

		if (search.trim()) {
			const lower = search.toLowerCase()
			result = result.filter(
				(m) =>
					m.id.toLowerCase().includes(lower) ||
					m.name.toLowerCase().includes(lower) ||
					(m.description ?? '').toLowerCase().includes(lower) ||
					(m.modality ?? '').toLowerCase().includes(lower) ||
					(m.instructType ?? '').toLowerCase().includes(lower) ||
					(m.inputModalities ?? []).join(' ').toLowerCase().includes(lower) ||
					(m.outputModalities ?? []).join(' ').toLowerCase().includes(lower)
			)
		}

		if (selectedInputMods.size > 0) {
			result = result.filter((m) => {
				const mods = new Set(m.inputModalities ?? [])
				for (const cap of selectedInputMods) {
					if (!mods.has(cap)) return false
				}
				return true
			})
		}

		if (selectedOutputMods.size > 0) {
			result = result.filter((m) => {
				const mods = new Set(m.outputModalities ?? [])
				for (const cap of selectedOutputMods) {
					if (!mods.has(cap)) return false
				}
				return true
			})
		}

		return result
	})

	function getCreator(id: string): string {
		const slash = id.indexOf('/')
		return slash > 0 ? id.slice(0, slash) : 'unknown'
	}

	const sorted = $derived.by(() => {
		const list = [...filtered]
		switch (sortBy) {
			case 'name':
				list.sort((a, b) => a.name.localeCompare(b.name))
				break
			case 'price':
				list.sort((a, b) => Number(a.promptPrice) - Number(b.promptPrice))
				break
			case 'context':
				list.sort((a, b) => (b.contextLength ?? 0) - (a.contextLength ?? 0))
				break
			case 'newest':
				list.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
				break
			case 'oldest':
				list.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
				break
		}
		return list
	})

	type GroupedModels = { creator: string; models: ModelInfo[] }[]

	const grouped = $derived.by((): GroupedModels | null => {
		if (!groupByCreator) return null
		const map = new Map<string, ModelInfo[]>()
		for (const m of sorted) {
			const creator = getCreator(m.id)
			if (!map.has(creator)) map.set(creator, [])
			map.get(creator)!.push(m)
		}
		return Array.from(map.entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([creator, models]) => ({ creator, models }))
	})

	const selectedLabel = $derived.by(() => {
		const found = models.find((m) => m.id === value)
		const fullName = found ? found.name : value
		// Strip the "Provider: " prefix when in inline mode (composer toolbar) so the label is compact.
		const colonIdx = fullName.indexOf(':')
		return isInline && colonIdx >= 0 ? fullName.slice(colonIdx + 1).trim() : fullName
	})

	function selectModel(id: string) {
		closeModal()
		onchange?.(id)
	}

	function formatPrice(value: string) {
		const perToken = Number(value)
		if (!Number.isFinite(perToken) || perToken === 0) return '$0'
		const perMillion = perToken * 1_000_000
		if (perMillion >= 100) return `$${perMillion.toFixed(0)}`
		if (perMillion >= 1) return `$${perMillion.toFixed(2)}`
		if (perMillion >= 0.01) return `$${perMillion.toFixed(4)}`
		return `$${perMillion.toPrecision(3)}`
	}

	function formatTokens(tokens: number | null | undefined) {
		if (!tokens || tokens <= 0) return 'Unknown'
		if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
		return `${Math.round(tokens / 1000)}k`
	}

	function formatContextLabel(tokens: number | null | undefined) {
		const compact = formatTokens(tokens)
		if (compact === 'Unknown') return 'Context: Unknown'
		return `Context: ${compact} tokens`
	}

	function clearFilters() {
		selectedInputMods = new Set()
		selectedOutputMods = new Set()
		groupByCreator = false
		sortBy = 'name'
	}
</script>

{#snippet capPill(cap: string, active: boolean, onclick: () => void)}
	<button
		type="button"
		class="badge badge-sm cursor-pointer transition {active ? 'badge-primary' : 'badge-outline hover:bg-base-200'}"
		{onclick}
	>
		{cap}
	</button>
{/snippet}

{#snippet modelCard(m: ModelInfo)}
	<button
		type="button"
		title={m.description || ''}
		class="hover:border-primary/40 hover:bg-base-200 flex min-w-0 cursor-pointer flex-col gap-0.5 overflow-hidden rounded-lg border bg-base-100 px-2.5 py-1.5 text-left transition {m.id ===
		value
			? 'ring-primary/50 border-primary/60 ring-2'
			: 'border-base-300'}"
		onclick={() => selectModel(m.id)}
	>
		<div class="flex min-w-0 items-center justify-between gap-2">
			<span class="truncate text-sm font-semibold">{m.name}</span>
			<span class="shrink-0 whitespace-nowrap font-mono text-xs opacity-60" title="Price per 1M tokens: input · output">
				{formatPrice(m.promptPrice)} · {formatPrice(m.completionPrice)}
			</span>
		</div>

		<div class="flex min-w-0 items-center gap-2 text-xs opacity-60">
			<span class="truncate">{m.id}</span>
			<span class="opacity-50">·</span>
			<span class="shrink-0 whitespace-nowrap">{formatTokens(m.contextLength)}</span>
			{#if m.modality}
				<span class="opacity-50">·</span>
				<span class="shrink-0 whitespace-nowrap">{m.modality}</span>
			{/if}
		</div>
	</button>
{/snippet}

<div class="relative {className}">
	<button
		type="button"
		class={isInline
			? `btn btn-ghost ${size === 'xs' ? 'btn-xs' : 'btn-sm'} gap-1 font-normal`
			: `input input-bordered flex w-full items-center justify-between gap-2 text-left ${sizeClass}`}
		onclick={() => {
			openModal()
		}}
	>
		<span class="truncate">{selectedLabel}</span>
		{#if showChevron}
			<span class="opacity-70">▾</span>
		{/if}
		{#if !isInline && showBrowseBadge}
			<span class="badge badge-ghost badge-xs">Browse</span>
		{/if}
	</button>

	{#if open}
		<div use:portal class="modal modal-open z-[1000]">
			<button
				type="button"
				class="modal-backdrop bg-neutral/60 absolute inset-0 backdrop-blur-sm"
				aria-label="Close model selector"
				onclick={closeModal}
			></button>

			<div
				class="bg-base-100 text-base-content border-base-300 relative mx-auto flex max-h-[85dvh] w-[95vw] flex-col overflow-hidden rounded-2xl border p-0 shadow-2xl tablet:max-h-[80vh] tablet:w-full tablet:max-w-5xl desktop:max-w-6xl"
			>
				<!-- Top bar: search + settings + close -->
				<div class="border-base-300 bg-base-100 flex items-center gap-2 border-b px-3 py-2">
					<div class="join flex-1">
						<input
							bind:this={inputEl}
							class="input input-bordered input-sm join-item flex-1"
							type="text"
							placeholder={models.length > 0 ? `Search ${filtered.length} of ${models.length} models…` : 'Search models…'}
							bind:value={search}
						/>

						<!-- Settings button -->
						<div class="dropdown dropdown-end" bind:this={settingsRef}>
							<button
								type="button"
								class="btn btn-sm btn-ghost join-item border-base-300 border relative"
								title="Sort & Filter"
								onclick={() => (settingsOpen = !settingsOpen)}
							>
								<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
									<path fill-rule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3 4a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm3 4a1 1 0 011-1h0a1 1 0 110 2h0a1 1 0 01-1-1z" clip-rule="evenodd" />
								</svg>
								{#if activeFilterCount > 0}
									<span class="badge badge-primary badge-xs absolute -right-1 -top-1">{activeFilterCount}</span>
								{/if}
							</button>

							{#if settingsOpen}
								<div
									class="bg-base-100 border-base-300 absolute right-0 top-full z-50 mt-1 w-64 rounded-box border p-2.5 shadow-xl"
								>
									<!-- Sort -->
									<div class="mb-2.5">
										<div class="mb-1 text-[11px] font-semibold uppercase tracking-wide opacity-50">Sort</div>
										<select
											class="select select-bordered select-xs w-full"
											bind:value={sortBy}
										>
											<option value="name">A → Z</option>
											<option value="price">Price: Low → High</option>
											<option value="context">Context: Largest</option>
											<option value="newest">Newest First</option>
											<option value="oldest">Oldest First</option>
										</select>
									</div>

									<!-- Input modalities -->
									<div class="mb-2.5">
										<div class="mb-1 text-[11px] font-semibold uppercase tracking-wide opacity-50">Input</div>
										<div class="flex flex-wrap gap-1">
											{#each availableInputMods as cap}
												{@render capPill(cap, selectedInputMods.has(cap), () => toggleIn(cap))}
											{/each}
										</div>
									</div>

									<!-- Output modalities -->
									<div class="mb-2.5">
										<div class="mb-1 text-[11px] font-semibold uppercase tracking-wide opacity-50">Output</div>
										<div class="flex flex-wrap gap-1">
											{#each availableOutputMods as cap}
												{@render capPill(cap, selectedOutputMods.has(cap), () => toggleOut(cap))}
											{/each}
										</div>
									</div>

									<!-- Group toggle -->
									<div class="border-base-300 flex items-center justify-between border-t pt-2">
										<label class="flex cursor-pointer items-center gap-2 text-xs">
											<input type="checkbox" class="toggle toggle-xs" bind:checked={groupByCreator} />
											Group by creator
										</label>
										{#if activeFilterCount > 0}
											<button
												type="button"
												class="text-error text-xs hover:underline"
												onclick={clearFilters}
											>
												Reset
											</button>
										{/if}
									</div>
								</div>
							{/if}
						</div>

						<button
							type="button"
							class="btn btn-sm btn-ghost join-item border-base-300 border"
							aria-label="Close"
							onclick={closeModal}
						>
							✕
						</button>
					</div>
				</div>

				<!-- Model list -->
				<div class="bg-base-100 min-h-0 flex-1 overflow-y-auto p-2">
					{#if filtered.length === 0}
						<div class="border-base-300 text-base-content/55 rounded-xl border border-dashed p-4 text-center text-sm">
							No models found for that search.
						</div>
					{:else if grouped}
						{#each grouped as group (group.creator)}
							<div class="mb-3">
								<h3 class="text-base-content/50 mb-1 px-1 text-xs font-semibold uppercase tracking-wide">{group.creator}</h3>
								<div class="grid grid-cols-1 gap-1.5 tablet:grid-cols-2 desktop:grid-cols-3 {gridSizeClass}">
									{#each group.models as m (m.id)}
										{@render modelCard(m)}
									{/each}
								</div>
							</div>
						{/each}
					{:else}
						<div class="grid grid-cols-1 gap-1.5 tablet:grid-cols-2 desktop:grid-cols-3 {gridSizeClass}">
							{#each sorted as m (m.id)}
								{@render modelCard(m)}
							{/each}
						</div>
					{/if}
				</div>
			</div>
		</div>
	{/if}
</div>

