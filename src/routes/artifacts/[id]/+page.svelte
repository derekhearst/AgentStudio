<svelte:head><title>{artifact?.title ?? 'Artifact'} | DrokBot</title></svelte:head>

<script lang="ts">
	import { page } from '$app/stores'
	import { onMount } from 'svelte'
	import { goto } from '$app/navigation'
	import {
		getArtifact,
		getArtifactVersions,
		deleteArtifact,
		pinArtifact,
		updateArtifactTags,
		updateArtifactCategory,
		rollbackArtifact,
	} from '$lib/artifacts'
	import ArtifactViewer from '$lib/artifacts/ArtifactViewer.svelte'

	type ArtifactData = Awaited<ReturnType<typeof getArtifact>>
	type VersionRow = Awaited<ReturnType<typeof getArtifactVersions>>[number]

	let artifact = $state<ArtifactData>(null)
	let versions = $state<VersionRow[]>([])
	let loading = $state(true)
	let showVersions = $state(false)
	let editingTags = $state(false)
	let tagInput = $state('')
	let editingCategory = $state(false)
	let categoryInput = $state('')

	const id = $derived($page.params.id!)

	onMount(() => { void load() })

	async function load() {
		loading = true
		try {
			const [a, v] = await Promise.all([
				getArtifact(id),
				getArtifactVersions(id),
			])
			artifact = a
			versions = v
			if (a) {
				tagInput = (a.tags ?? []).join(', ')
				categoryInput = a.category ?? ''
			}
		} finally {
			loading = false
		}
	}

	async function handleDelete() {
		if (!confirm('Delete this artifact permanently?')) return
		await deleteArtifact(id)
		await goto('/artifacts')
	}

	async function handleTogglePin() {
		if (!artifact) return
		await pinArtifact({ id, pinned: !artifact.pinned })
		await load()
	}

	async function handleSaveTags() {
		const tags = tagInput.split(',').map(t => t.trim()).filter(Boolean)
		await updateArtifactTags({ id, tags })
		editingTags = false
		await load()
	}

	async function handleSaveCategory() {
		await updateArtifactCategory({ id, category: categoryInput.trim() || null })
		editingCategory = false
		await load()
	}

	async function handleRollback(version: number) {
		if (!confirm(`Restore version ${version}? This creates a new version with the old content.`)) return
		await rollbackArtifact({ id, version })
		await load()
	}

	async function handleDownload() {
		if (!artifact) return
		const ext = artifact.language ?? (artifact.type === 'markdown' ? 'md' : artifact.type === 'html' ? 'html' : 'txt')
		const blob = new Blob([artifact.content], { type: 'text/plain' })
		const url = URL.createObjectURL(blob)
		const a = document.createElement('a')
		a.href = url
		a.download = `${artifact.title}.${ext}`
		a.click()
		URL.revokeObjectURL(url)
	}

	async function handleCopy() {
		if (!artifact) return
		await navigator.clipboard.writeText(artifact.content)
	}

	function formatDate(d: Date | string) {
		return new Date(d).toLocaleString()
	}

	function handleContinueWorking() {
		if (!artifact) return
		// Navigate to chat with context about continuing work on this artifact
		goto(`/chat?artifactId=${artifact.id}`)
	}
</script>

{#if loading}
	<section class="space-y-4">
		<div class="rounded-3xl border border-base-300 bg-base-100 p-6">
			<div class="skeleton h-8 w-64"></div>
			<div class="skeleton mt-4 h-96 w-full"></div>
		</div>
	</section>
{:else if !artifact}
	<section class="rounded-3xl border border-base-300 bg-base-100 p-8 text-center">
		<p class="text-lg font-medium text-base-content/70">Artifact not found</p>
		<a href="/artifacts" class="btn btn-outline mt-3">Back to Artifacts</a>
	</section>
{:else}
	<section class="space-y-4">
		<!-- Header -->
		<header class="rounded-3xl border border-base-300 bg-base-100 p-5">
			<div class="flex flex-wrap items-start justify-between gap-3">
				<div>
					<div class="flex items-center gap-2">
						<a href="/artifacts" class="btn btn-sm btn-ghost">← Back</a>
						<h1 class="text-2xl font-bold">{artifact.title}</h1>
						{#if artifact.pinned}
							<span class="text-warning" title="Pinned">📌</span>
						{/if}
					</div>
					<div class="mt-2 flex flex-wrap gap-2">
						<span class="badge badge-primary">{artifact.type}</span>
						{#if artifact.language}
							<span class="badge badge-ghost">{artifact.language}</span>
						{/if}
						{#if artifact.category}
							<span class="badge badge-secondary">{artifact.category}</span>
						{/if}
					</div>
				</div>
				<div class="flex flex-wrap gap-2">
					<button class="btn btn-sm btn-outline" type="button" onclick={handleCopy}>Copy</button>
					<button class="btn btn-sm btn-outline" type="button" onclick={handleDownload}>Download</button>
					<button class="btn btn-sm btn-outline" type="button" onclick={handleTogglePin}>
						{artifact.pinned ? 'Unpin' : 'Pin'}
					</button>
					<button class="btn btn-sm btn-outline" type="button" onclick={handleContinueWorking}>
						Continue in Chat
					</button>
					<button class="btn btn-sm btn-error btn-outline" type="button" onclick={handleDelete}>Delete</button>
				</div>
			</div>
		</header>

		<div class="grid gap-4 xl:grid-cols-[2fr_1fr]">
			<!-- Main Viewer -->
			<div class="rounded-3xl border border-base-300 bg-base-100 p-4">
				<ArtifactViewer
					artifact={{ id: artifact.id, type: artifact.type, title: artifact.title, content: artifact.content, language: artifact.language, mimeType: artifact.mimeType ?? null, url: artifact.url ?? null, pinned: artifact.pinned }}
					onClose={() => goto('/artifacts')}
				/>
			</div>

			<!-- Metadata Sidebar -->
			<aside class="space-y-4">
				<!-- Info Card -->
				<div class="rounded-3xl border border-base-300 bg-base-100 p-4 space-y-3">
					<h2 class="text-lg font-semibold">Details</h2>
					<div class="space-y-2 text-sm">
						<div class="flex justify-between">
							<span class="text-base-content/70">Created</span>
							<span>{formatDate(artifact.createdAt)}</span>
						</div>
						<div class="flex justify-between">
							<span class="text-base-content/70">Updated</span>
							<span>{formatDate(artifact.updatedAt)}</span>
						</div>
						<div class="flex justify-between">
							<span class="text-base-content/70">Accessed</span>
							<span>{artifact.accessCount} times</span>
						</div>
						{#if artifact.lastAccessed}
							<div class="flex justify-between">
								<span class="text-base-content/70">Last accessed</span>
								<span>{formatDate(artifact.lastAccessed)}</span>
							</div>
						{/if}
						{#if artifact.conversationId}
							<div class="flex justify-between">
								<span class="text-base-content/70">Source</span>
								<a href="/chat/{artifact.conversationId}" class="link link-primary">Conversation</a>
							</div>
						{/if}
						{#if artifact.mimeType}
							<div class="flex justify-between">
								<span class="text-base-content/70">MIME type</span>
								<span>{artifact.mimeType}</span>
							</div>
						{/if}
					</div>
				</div>

				<!-- Category -->
				<div class="rounded-3xl border border-base-300 bg-base-100 p-4 space-y-2">
					<div class="flex items-center justify-between">
						<h2 class="text-lg font-semibold">Category</h2>
						<button class="btn btn-xs btn-ghost" type="button" onclick={() => editingCategory = !editingCategory}>
							{editingCategory ? 'Cancel' : 'Edit'}
						</button>
					</div>
					{#if editingCategory}
						<div class="flex gap-2">
							<input class="input input-bordered input-sm flex-1" bind:value={categoryInput} placeholder="Category" />
							<button class="btn btn-sm btn-success" type="button" onclick={handleSaveCategory}>Save</button>
						</div>
					{:else}
						<p class="text-sm">{artifact.category ?? 'Uncategorized'}</p>
					{/if}
				</div>

				<!-- Tags -->
				<div class="rounded-3xl border border-base-300 bg-base-100 p-4 space-y-2">
					<div class="flex items-center justify-between">
						<h2 class="text-lg font-semibold">Tags</h2>
						<button class="btn btn-xs btn-ghost" type="button" onclick={() => editingTags = !editingTags}>
							{editingTags ? 'Cancel' : 'Edit'}
						</button>
					</div>
					{#if editingTags}
						<div class="space-y-2">
							<input class="input input-bordered input-sm w-full" bind:value={tagInput} placeholder="Comma-separated tags" />
							<button class="btn btn-sm btn-success" type="button" onclick={handleSaveTags}>Save</button>
						</div>
					{:else if artifact.tags && artifact.tags.length > 0}
						<div class="flex flex-wrap gap-1">
							{#each artifact.tags as tag (tag)}
								<span class="badge badge-outline">{tag}</span>
							{/each}
						</div>
					{:else}
						<p class="text-sm text-base-content/50">No tags</p>
					{/if}
				</div>

				<!-- Versions -->
				<div class="rounded-3xl border border-base-300 bg-base-100 p-4 space-y-2">
					<div class="flex items-center justify-between">
						<h2 class="text-lg font-semibold">Versions ({versions.length})</h2>
						<button class="btn btn-xs btn-ghost" type="button" onclick={() => showVersions = !showVersions}>
							{showVersions ? 'Hide' : 'Show'}
						</button>
					</div>
					{#if showVersions}
						<div class="space-y-2 max-h-64 overflow-y-auto">
							{#each versions as ver (ver.id)}
								<div class="rounded-xl border border-base-300 bg-base-200/30 p-3 text-sm">
									<div class="flex items-center justify-between">
										<span class="font-medium">v{ver.version}</span>
										<span class="text-xs text-base-content/50">{formatDate(ver.createdAt)}</span>
									</div>
									{#if ver.version < versions.length}
										<button class="btn btn-xs btn-outline mt-1" type="button" onclick={() => handleRollback(ver.version)}>
											Restore
										</button>
									{:else}
										<span class="badge badge-success badge-xs mt-1">Current</span>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				</div>
			</aside>
		</div>
	</section>
{/if}

