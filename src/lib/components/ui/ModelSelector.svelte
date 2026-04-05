<script lang="ts">
	import { tick } from 'svelte'
	import { getAvailableModels } from '$lib/llm/models.remote'
	import type { ModelInfo } from '$lib/llm/models'

	interface Props {
		value?: string
		onchange?: (modelId: string) => void
		class?: string
		size?: 'xs' | 'sm' | 'default'
		variant?: 'default' | 'inline'
		showChevron?: boolean
		showBrowseBadge?: boolean
	}

	let {
		value = 'anthropic/claude-sonnet-4',
		onchange,
		class: className = '',
		size = 'default',
		variant = 'default',
		showChevron = true,
		showBrowseBadge = true,
	}: Props = $props()

	let models: ModelInfo[] = $state.raw([])
	$effect(() => {
		getAvailableModels().then((m) => (models = m))
	})
	let search = $state('')
	let open = $state(false)
	let closing = $state(false)
	let ready = $state(false)
	let settingsOpen = $state(false)
	let settingsClosing = $state(false)
	let inputEl: HTMLInputElement | undefined = $state()
	let settingsRef: HTMLDivElement | undefined = $state()

	function openModal() {
		open = true
		ready = false
		requestAnimationFrame(() => {
			ready = true
		})
	}

	function closeModal() {
		if (closing) return
		closing = true
		setTimeout(() => {
			open = false
			closing = false
			ready = false
			search = ''
		}, 150)
	}

	function closeSettings() {
		if (settingsClosing) return
		settingsClosing = true
		setTimeout(() => {
			settingsOpen = false
			settingsClosing = false
		}, 120)
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
			settingsClosing = false
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
			if (settingsOpen && !settingsClosing && settingsRef && !settingsRef.contains(e.target as Node)) {
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
		return found ? found.name : value
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
		class="rounded-full border px-2 py-0.5 text-xs transition {active ? 'border-primary bg-primary/15 text-primary' : 'border-base-300 hover:bg-base-200'}"
		{onclick}
	>
		{cap}
	</button>
{/snippet}

{#snippet modelCard(m: ModelInfo)}
	<button
		type="button"
		class="flex min-w-0 flex-col gap-1.5 overflow-hidden rounded-lg border border-base-300 p-2 text-left transition hover:border-primary/50 hover:bg-base-200/60 sm:gap-2 sm:rounded-xl sm:p-3 {m.id === value ? 'ring-2 ring-primary/40 border-primary/60' : ''}"
		style="background-color: color-mix(in srgb, Canvas 92%, CanvasText 8%)"
		onclick={() => selectModel(m.id)}
	>
		<div class="flex min-w-0 items-center justify-between gap-1.5">
			<span class="truncate text-xs font-semibold sm:text-sm">{m.name}</span>
			<span class="badge badge-outline badge-xs shrink-0 whitespace-nowrap">{formatContextLabel(m.contextLength)}</span>
		</div>

		<div class="truncate text-[10px] opacity-50 sm:text-xs">{m.id}</div>

		<div class="line-clamp-2 text-[11px] leading-snug opacity-70 sm:text-xs">
			{m.description || 'No description available.'}
		</div>

		<div class="flex flex-wrap items-center gap-1 pt-0.5 text-[10px] sm:text-xs">
			{#if m.modality}
				<span class="badge badge-ghost badge-xs">{m.modality}</span>
			{/if}
			{#if m.instructType}
				<span class="badge badge-ghost badge-xs">{m.instructType}</span>
			{/if}
			{#if m.isModerated !== null && m.isModerated !== undefined}
				<span class="badge badge-ghost badge-xs">{m.isModerated ? 'moderated' : 'unmoderated'}</span>
			{/if}
			<span class="ml-auto shrink-0 font-mono opacity-60" title="Price per 1M tokens: input / output">
				{formatPrice(m.promptPrice)}<span class="opacity-50">/M in</span> · {formatPrice(m.completionPrice)}<span class="opacity-50">/M out</span>
			</span>
		</div>
	</button>
{/snippet}

<div class="relative {className}">
	<button
		type="button"
		class="{isInline
			? `inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-base-content/85 hover:bg-base-200 ${size === 'xs' ? 'text-xs' : ''}`
			: `input input-bordered flex w-full items-center justify-between gap-2 text-left ${sizeClass}`
		}"
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
		<div class="fixed inset-0 z-1000 overflow-hidden">
			<button
				type="button"
				class="modal-backdrop absolute inset-0 bg-black/65"
				class:modal-backdrop-closing={closing}
				aria-label="Close model selector"
				onclick={closeModal}
			></button>

			<div
				class="modal-panel relative mx-auto flex h-dvh w-full max-w-full flex-col overflow-hidden bg-base-100 shadow-2xl sm:mt-[6vh] sm:h-[82vh] sm:w-[96vw] sm:max-w-6xl sm:rounded-2xl sm:border sm:border-base-300"
				class:modal-panel-closing={closing}
				style="background-color: Canvas; color: CanvasText; opacity: 1"
			>
				<!-- Top bar: search + settings + count + close -->
				<div class="flex items-center gap-2 border-b border-base-300 px-3 py-2 sm:px-4 sm:py-2.5" style="background-color: Canvas">
					<h2 class="hidden text-sm font-bold sm:block sm:text-base">Models</h2>
					<input
						bind:this={inputEl}
						class="input input-bordered input-xs flex-1 sm:input-sm"
						type="text"
						placeholder="Search models..."
						bind:value={search}
					/>

					<!-- Settings button -->
					<div class="relative" bind:this={settingsRef}>
						<button
							type="button"
							class="btn btn-ghost btn-xs relative sm:btn-sm"
							title="Sort & Filter"
							onclick={() => (settingsOpen = !settingsOpen)}
						>
							<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
								<path fill-rule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3 4a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm3 4a1 1 0 011-1h0a1 1 0 110 2h0a1 1 0 01-1-1z" clip-rule="evenodd" />
							</svg>
							{#if activeFilterCount > 0}
								<span class="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[9px] font-bold text-primary-content">{activeFilterCount}</span>
							{/if}
						</button>

						{#if settingsOpen}
							<div
								class="settings-dropdown absolute right-0 top-full z-50 mt-1 w-64 rounded-xl border border-base-300 bg-base-100 p-3 shadow-xl sm:w-72"
								class:settings-dropdown-closing={settingsClosing}
								style="background-color: Canvas"
							>
								<!-- Sort -->
								<div class="mb-3">
									<div class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide opacity-50">Sort</div>
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
								<div class="mb-3">
									<div class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide opacity-50">Input</div>
									<div class="flex flex-wrap gap-1">
										{#each availableInputMods as cap}
											{@render capPill(cap, selectedInputMods.has(cap), () => toggleIn(cap))}
										{/each}
									</div>
								</div>

								<!-- Output modalities -->
								<div class="mb-3">
									<div class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide opacity-50">Output</div>
									<div class="flex flex-wrap gap-1">
										{#each availableOutputMods as cap}
											{@render capPill(cap, selectedOutputMods.has(cap), () => toggleOut(cap))}
										{/each}
									</div>
								</div>

								<!-- Group toggle -->
								<div class="flex items-center justify-between border-t border-base-300 pt-2.5">
									<label class="flex cursor-pointer items-center gap-2 text-xs">
										<input type="checkbox" class="toggle toggle-xs" bind:checked={groupByCreator} />
										Group by creator
									</label>
									{#if activeFilterCount > 0}
										<button
											type="button"
											class="text-xs text-error hover:underline"
											onclick={clearFilters}
										>
											Reset
										</button>
									{/if}
								</div>
							</div>
						{/if}
					</div>

					<span class="hidden text-xs text-base-content/55 sm:inline">
						{filtered.length}
					</span>

					<button
						type="button"
						class="btn btn-ghost btn-xs sm:btn-sm"
						onclick={closeModal}
					>
						✕
					</button>
				</div>

				<!-- Model grid -->
				<div
					class="min-h-0 flex-1 overflow-y-auto p-2 sm:p-4"
					style="background-color: Canvas"
				>
					{#if filtered.length === 0 && ready}
						<div class="rounded-xl border border-dashed border-base-300 p-4 text-center text-sm text-base-content/55 sm:p-6 sm:text-base">
							No models found for that search.
						</div>
					{:else if grouped && ready}
						{#each grouped as group (group.creator)}
							<div class="mb-4">
								<h3 class="mb-2 px-1 text-sm font-semibold capitalize text-base-content/70 sm:text-base">{group.creator}</h3>
								<div class="grid grid-cols-1 gap-2 sm:gap-3 lg:grid-cols-2 xl:grid-cols-3 {gridSizeClass}">
									{#each group.models as m (m.id)}
										{@render modelCard(m)}
									{/each}
								</div>
							</div>
						{/each}
					{:else if ready}
						<div class="grid grid-cols-1 gap-2 sm:gap-3 lg:grid-cols-2 xl:grid-cols-3 {gridSizeClass}">
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

<style>
	.modal-backdrop {
		animation: fadeIn 150ms ease-out;
		will-change: opacity;
	}
	.modal-backdrop-closing {
		animation: fadeOut 150ms ease-in forwards;
		will-change: opacity;
	}
	.modal-panel {
		animation: slideUp 200ms ease-out;
		will-change: transform, opacity;
	}
	.modal-panel-closing {
		animation: slideDown 150ms ease-in forwards;
		will-change: transform, opacity;
	}
	@media (min-width: 640px) {
		.modal-panel {
			animation: scaleIn 200ms ease-out;
		}
		.modal-panel-closing {
			animation: scaleOut 150ms ease-in forwards;
		}
	}
	.settings-dropdown {
		animation: dropIn 150ms ease-out;
		transform-origin: top right;
		will-change: transform, opacity;
	}
	.settings-dropdown-closing {
		animation: dropOut 120ms ease-in forwards;
		transform-origin: top right;
		will-change: transform, opacity;
	}
	@keyframes fadeIn {
		from { opacity: 0; }
		to { opacity: 1; }
	}
	@keyframes fadeOut {
		from { opacity: 1; }
		to { opacity: 0; }
	}
	@keyframes scaleIn {
		from { opacity: 0; transform: scale(0.95); }
		to { opacity: 1; transform: scale(1); }
	}
	@keyframes scaleOut {
		from { opacity: 1; transform: scale(1); }
		to { opacity: 0; transform: scale(0.95); }
	}
	@keyframes slideUp {
		from { opacity: 0; transform: translateY(100%); }
		to { opacity: 1; transform: translateY(0); }
	}
	@keyframes slideDown {
		from { opacity: 1; transform: translateY(0); }
		to { opacity: 0; transform: translateY(100%); }
	}
	@keyframes dropIn {
		from { opacity: 0; transform: scale(0.9) translateY(-4px); }
		to { opacity: 1; transform: scale(1) translateY(0); }
	}
	@keyframes dropOut {
		from { opacity: 1; transform: scale(1) translateY(0); }
		to { opacity: 0; transform: scale(0.9) translateY(-4px); }
	}
</style>
