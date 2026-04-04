<script lang="ts">
	import { getAvailableModels } from '$lib/server/llm/models.remote'

	interface Props {
		value?: string
		onchange?: (modelId: string) => void
		class?: string
		size?: 'xs' | 'sm' | 'default'
	}

	let {
		value = 'anthropic/claude-sonnet-4',
		onchange,
		class: className = '',
		size = 'default',
	}: Props = $props()

	let models = $derived(await getAvailableModels())
	let search = $state('')
	let open = $state(false)
	let listEl: HTMLUListElement | undefined = $state()
	let inputEl: HTMLInputElement | undefined = $state()

	const sizeClass = $derived(
		size === 'xs' ? 'input-xs text-xs' : size === 'sm' ? 'input-sm text-sm' : ''
	)

	const dropdownSizeClass = $derived(
		size === 'xs' ? 'text-xs' : size === 'sm' ? 'text-sm' : ''
	)

	const filtered = $derived.by(() => {
		if (!search.trim()) return models
		const lower = search.toLowerCase()
		return models.filter(
			(m) => m.id.toLowerCase().includes(lower) || m.name.toLowerCase().includes(lower)
		)
	})

	const selectedLabel = $derived.by(() => {
		const found = models.find((m) => m.id === value)
		return found ? found.name : value
	})

	function selectModel(id: string) {
		open = false
		search = ''
		onchange?.(id)
	}

	function handleInputKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			open = false
			search = ''
		} else if (e.key === 'ArrowDown') {
			e.preventDefault()
			const first = listEl?.querySelector('li button') as HTMLElement | null
			first?.focus()
		}
	}

	function handleItemKeydown(e: KeyboardEvent, id: string) {
		if (e.key === 'Enter') {
			selectModel(id)
		} else if (e.key === 'Escape') {
			open = false
			search = ''
			inputEl?.focus()
		}
	}
</script>

<div class="relative {className}">
	{#if open}
		<input
			bind:this={inputEl}
			class="input input-bordered w-full {sizeClass}"
			type="text"
			placeholder="Search models..."
			bind:value={search}
			onkeydown={handleInputKeydown}
			onblur={(e) => {
				if (!e.relatedTarget || !(e.relatedTarget as HTMLElement).closest('.model-dropdown')) {
					setTimeout(() => { open = false; search = '' }, 150)
				}
			}}
		/>
		<ul
			bind:this={listEl}
			class="model-dropdown absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-base-300 bg-base-100 shadow-lg {dropdownSizeClass}"
		>
			{#if filtered.length === 0}
				<li class="px-3 py-2 text-base-content/50">No models found</li>
			{:else}
				{#each filtered as m (m.id)}
					<li>
						<button
							type="button"
							class="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-base-200 focus:bg-base-200 focus:outline-none {m.id === value ? 'bg-primary/10' : ''}"
							onclick={() => selectModel(m.id)}
							onkeydown={(e) => handleItemKeydown(e, m.id)}
						>
							<span class="flex flex-col">
								<span class="font-medium">{m.name}</span>
								<span class="text-[0.65rem] opacity-50">{m.id}</span>
							</span>
							<span class="text-[0.65rem] opacity-40">
								{m.contextLength ? `${(m.contextLength / 1000).toFixed(0)}k` : ''}
							</span>
						</button>
					</li>
				{/each}
			{/if}
		</ul>
	{:else}
		<button
			type="button"
			class="input input-bordered flex w-full items-center text-left {sizeClass}"
			onclick={() => {
				open = true
				requestAnimationFrame(() => inputEl?.focus())
			}}
		>
			<span class="truncate">{selectedLabel}</span>
		</button>
	{/if}
</div>
