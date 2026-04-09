<svelte:head><title>Artifacts | AgentStudio</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte'
	import { listArtifacts, deleteArtifact } from '$lib/artifacts'

	type ArtifactRow = Awaited<ReturnType<typeof listArtifacts>>[number]

	let artifacts = $state<ArtifactRow[]>([])
	let loading = $state(true)
	let search = $state('')
	let typeFilter = $state<typeof typeOptions[number] | ''>('')
	let categoryFilter = $state('')
	let viewMode = $state<'list' | 'grid' | 'gallery'>('grid')
	let offset = $state(0)
	const limit = 50

	const typeOptions = ['markdown', 'code', 'config', 'image', 'svg', 'html', 'chart', 'data_table', 'audio', 'video', 'mermaid', 'svelte'] as const

	const typeIcons: Record<string, string> = {
		markdown: '📄', code: '💻', config: '⚙️', image: '🖼️', svg: '🎨',
		html: '🌐', chart: '📊', data_table: '📋', audio: '🎵', video: '🎬',
		mermaid: '🧜', svelte: '🔥',
	}

	onMount(() => { void loadArtifacts() })

	async function loadArtifacts() {
		loading = true
		try {
			artifacts = await listArtifacts({
				search: search.trim() || undefined,
				type: (typeFilter || undefined) as typeof typeOptions[number] | undefined,
				category: categoryFilter || undefined,
				limit,
				offset,
			})
		} finally {
			loading = false
		}
	}

	async function handleSearch() {
		offset = 0
		await loadArtifacts()
	}

	async function handleDelete(id: string) {
		if (!confirm('Delete this artifact? This cannot be undone.')) return
		await deleteArtifact(id)
		await loadArtifacts()
	}

	async function handleLoadMore() {
		offset += limit
		const more = await listArtifacts({
			search: search.trim() || undefined,
			type: (typeFilter || undefined) as typeof typeOptions[number] | undefined,
			category: categoryFilter || undefined,
			limit,
			offset,
		})
		artifacts = [...artifacts, ...more]
	}

	function formatDate(d: Date | string) {
		return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
	}

	function truncate(text: string, max: number) {
		return text.length > max ? text.slice(0, max) + '…' : text
	}

	const categories = $derived([...new Set(artifacts.map(a => a.category).filter(Boolean))])
</script>

<section class="space-y-5">
	<!-- Header -->
	<header class="rounded-3xl border border-base-300 bg-base-100 p-5">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div>
				<h1 class="text-3xl font-bold">Artifacts</h1>
				<p class="text-sm text-base-content/70">
					Browse, search, and manage all generated artifacts — documents, code, images, diagrams, and more.
				</p>
			</div>
			<div class="flex items-center gap-2">
				<!-- View mode toggle -->
				<div class="join">
					<button class="btn btn-sm join-item" class:btn-active={viewMode === 'grid'} onclick={() => viewMode = 'grid'} type="button" aria-label="Grid view">
						<svg xmlns="http://www.w3.org/2000/svg" class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
							<rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
						</svg>
					</button>
					<button class="btn btn-sm join-item" class:btn-active={viewMode === 'list'} onclick={() => viewMode = 'list'} type="button" aria-label="List view">
						<svg xmlns="http://www.w3.org/2000/svg" class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
							<line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
						</svg>
					</button>
					<button class="btn btn-sm join-item" class:btn-active={viewMode === 'gallery'} onclick={() => viewMode = 'gallery'} type="button" aria-label="Gallery view">
						<svg xmlns="http://www.w3.org/2000/svg" class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>
						</svg>
					</button>
				</div>
			</div>
		</div>
	</header>

	<!-- Filters -->
	<div class="rounded-3xl border border-base-300 bg-base-100 p-4">
		<div class="grid gap-2 md:grid-cols-[1.5fr_1fr_1fr_auto_auto]">
			<input
				class="input input-bordered"
				bind:value={search}
				placeholder="Search artifacts by title or content…"
				onkeydown={(e) => e.key === 'Enter' && handleSearch()}
			/>
			<select class="select select-bordered" bind:value={typeFilter} onchange={handleSearch}>
				<option value="">All types</option>
				{#each typeOptions as t (t)}
					<option value={t}>{typeIcons[t]} {t}</option>
				{/each}
			</select>
			<select class="select select-bordered" bind:value={categoryFilter} onchange={handleSearch}>
				<option value="">All categories</option>
				{#each categories as cat (cat)}
					<option value={cat}>{cat}</option>
				{/each}
			</select>
			<button class="btn btn-outline" type="button" onclick={handleSearch}>Search</button>
		</div>
	</div>

	<!-- Loading -->
	{#if loading}
		<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
			{#each Array.from({ length: 6 }) as _, idx (`skeleton-${idx}`)}
				<div class="rounded-2xl border border-base-300 bg-base-100 p-4">
					<div class="skeleton h-4 w-32"></div>
					<div class="skeleton mt-3 h-20 w-full"></div>
				</div>
			{/each}
		</div>
	{:else if artifacts.length === 0}
		<div class="rounded-3xl border border-base-300 bg-base-100 p-8 text-center">
			<p class="text-lg font-medium text-base-content/70">No artifacts found</p>
			<p class="mt-1 text-sm text-base-content/50">Artifacts are created when AgentStudio generates code, documents, images, or other content in chat.</p>
		</div>
	{:else}

		<!-- Grid View -->
		{#if viewMode === 'grid'}
			<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
				{#each artifacts as artifact (artifact.id)}
					<article class="group rounded-2xl border border-base-300 bg-base-100 p-4 transition hover:border-primary/40 hover:shadow">
						<div class="flex items-start justify-between gap-2">
							<div class="flex items-center gap-2">
								<span class="text-lg">{typeIcons[artifact.type] ?? '📦'}</span>
								<div>
									<a href="/artifacts/{artifact.id}" class="font-medium hover:text-primary">{artifact.title}</a>
									<div class="flex flex-wrap gap-1 mt-0.5">
										<span class="badge badge-outline badge-xs">{artifact.type}</span>
										{#if artifact.language}
											<span class="badge badge-ghost badge-xs">{artifact.language}</span>
										{/if}
										{#if artifact.category}
											<span class="badge badge-secondary badge-xs">{artifact.category}</span>
										{/if}
									</div>
								</div>
							</div>
							{#if artifact.pinned}
								<span class="text-warning text-sm" title="Pinned">📌</span>
							{/if}
						</div>
						<p class="mt-2 text-sm text-base-content/70 line-clamp-3">{truncate(artifact.content, 200)}</p>
						{#if artifact.tags && artifact.tags.length > 0}
							<div class="mt-2 flex flex-wrap gap-1">
								{#each artifact.tags.slice(0, 5) as tag (tag)}
									<span class="badge badge-outline badge-xs">{tag}</span>
								{/each}
							</div>
						{/if}
						<div class="mt-3 flex items-center justify-between text-xs text-base-content/50">
							<span>{formatDate(artifact.createdAt)}</span>
							<div class="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
								<a class="btn btn-xs btn-ghost" href="/artifacts/{artifact.id}">Open</a>
								<button class="btn btn-xs btn-ghost text-error" type="button" onclick={() => handleDelete(artifact.id)}>
									Delete
								</button>
							</div>
						</div>
					</article>
				{/each}
			</div>

		<!-- List View -->
		{:else if viewMode === 'list'}
			<div class="rounded-3xl border border-base-300 bg-base-100 overflow-x-auto">
				<table class="table table-zebra">
					<thead>
						<tr>
							<th>Type</th>
							<th>Title</th>
							<th>Category</th>
							<th>Language</th>
							<th>Created</th>
							<th>Accessed</th>
							<th></th>
						</tr>
					</thead>
					<tbody>
						{#each artifacts as artifact (artifact.id)}
							<tr class="hover">
								<td>
									<span class="text-lg">{typeIcons[artifact.type] ?? '📦'}</span>
									<span class="badge badge-outline badge-xs ml-1">{artifact.type}</span>
								</td>
								<td>
									<a href="/artifacts/{artifact.id}" class="link link-hover font-medium">{artifact.title}</a>
									{#if artifact.pinned}<span class="text-warning ml-1" title="Pinned">📌</span>{/if}
								</td>
								<td>{artifact.category ?? '—'}</td>
								<td>{artifact.language ?? '—'}</td>
								<td class="text-sm">{formatDate(artifact.createdAt)}</td>
								<td class="text-sm">{artifact.accessCount}</td>
								<td>
									<div class="flex gap-1">
										<button class="btn btn-xs btn-ghost text-error" type="button" onclick={() => handleDelete(artifact.id)}>
											Delete
										</button>
									</div>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

		<!-- Gallery View -->
		{:else if viewMode === 'gallery'}
			<div class="grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
				{#each artifacts as artifact (artifact.id)}
					<a href="/artifacts/{artifact.id}" class="group rounded-2xl border border-base-300 bg-base-100 overflow-hidden transition hover:border-primary/40 hover:shadow">
						<div class="aspect-video bg-base-200 flex items-center justify-center text-4xl">
							{#if artifact.type === 'image' && artifact.url}
								<img src={artifact.url} alt={artifact.title} class="h-full w-full object-cover" />
							{:else}
								{typeIcons[artifact.type] ?? '📦'}
							{/if}
						</div>
						<div class="p-3">
							<p class="font-medium text-sm truncate">{artifact.title}</p>
							<div class="flex items-center gap-1 mt-1">
								<span class="badge badge-outline badge-xs">{artifact.type}</span>
								{#if artifact.pinned}<span class="text-warning text-xs">📌</span>{/if}
							</div>
						</div>
					</a>
				{/each}
			</div>
		{/if}

		<!-- Load More -->
		{#if artifacts.length >= offset + limit}
			<div class="text-center">
				<button class="btn btn-outline" type="button" onclick={handleLoadMore}>
					Load more
				</button>
			</div>
		{/if}
	{/if}
</section>
