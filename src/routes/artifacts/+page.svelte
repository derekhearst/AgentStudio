<svelte:head><title>Artifacts | AgentStudio</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import {
		listRecentArtifactsQuery,
		type ArtifactFeedItem,
		type ImageFeedItem,
	} from '$lib/artifacts/artifacts-feed.remote';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';

	type FeedType = 'all' | 'research' | 'image' | 'document';

	let items = $state<ArtifactFeedItem[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let filter = $state<FeedType>('all');
	let lightboxImage = $state<ImageFeedItem | null>(null);
	let lightboxDialog: HTMLDialogElement | null = $state(null);

	onMount(() => {
		void load(filter);
	});

	async function load(type: FeedType) {
		loading = true;
		error = null;
		try {
			items = await listRecentArtifactsQuery({ type, limit: 60 });
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load artifacts';
		} finally {
			loading = false;
		}
	}

	function setFilter(next: FeedType) {
		if (next === filter) return;
		filter = next;
		void load(next);
	}

	function relativeTime(d: Date | string): string {
		const diff = Date.now() - new Date(d).getTime();
		if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
		if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
		return `${Math.floor(diff / 86_400_000)}d ago`;
	}

	function statusTone(status: string): string {
		switch (status) {
			case 'planning':
			case 'searching':
			case 'fetching':
			case 'reflecting':
			case 'synthesizing':
				return 'badge-info';
			case 'complete':
				return 'badge-success';
			case 'failed':
				return 'badge-error';
			case 'canceled':
				return 'badge-neutral';
			default:
				return 'badge-ghost';
		}
	}

	function isInFlight(status: string): boolean {
		return ['planning', 'searching', 'fetching', 'reflecting', 'synthesizing'].includes(status);
	}

	function openLightbox(item: ImageFeedItem) {
		lightboxImage = item;
		lightboxDialog?.showModal();
	}

	function closeLightbox() {
		lightboxDialog?.close();
		lightboxImage = null;
	}

	const FILTERS: Array<{ value: FeedType; label: string; icon: string }> = [
		{ value: 'all', label: 'All', icon: 'mdi-view-grid-outline' },
		{ value: 'research', label: 'Research', icon: 'mdi-magnify' },
		{ value: 'image', label: 'Images', icon: 'mdi-image-outline' },
		{ value: 'document', label: 'Documents', icon: 'mdi-file-document-outline' }
	];
</script>

<div class="flex h-full min-h-0 flex-col space-y-3 sm:space-y-4">
	<ContentPanel>
		{#snippet header()}
			<div class="flex flex-1 flex-wrap items-center justify-between gap-2">
				<div>
					<h1 class="text-xl font-bold sm:text-3xl">Artifacts</h1>
					<p class="text-xs text-base-content/70 sm:text-sm">
						Everything the agent has produced for you — research reports, generated images, and project documents.
					</p>
				</div>
			</div>
		{/snippet}

		<div class="mt-3 flex flex-wrap gap-1.5">
			{#each FILTERS as f}
				<button
					type="button"
					class="btn btn-xs gap-1.5 {filter === f.value ? 'btn-primary' : 'btn-ghost'}"
					onclick={() => setFilter(f.value)}
				>
					<i class="mdi {f.icon} text-sm opacity-80"></i>
					{f.label}
				</button>
			{/each}
		</div>
	</ContentPanel>

	{#if loading}
		<div class="flex justify-center py-20">
			<span class="loading loading-spinner loading-lg text-primary"></span>
		</div>
	{:else if error}
		<div class="alert alert-error text-sm">{error}</div>
	{:else if items.length === 0}
		<div
			class="card card-body bg-base-200/30 border-base-300/60 rounded-2xl border p-12 text-center text-sm text-base-content/55"
		>
			Nothing here yet — generate something from chat. Research reports, images, and project
			documents will all show up here.
		</div>
	{:else}
		<ul class="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
			{#each items as item (item.kind + ':' + item.id)}
				<li>
					{#if item.kind === 'research'}
						<a
							href={item.href}
							class="flex h-full flex-col gap-1.5 rounded-xl border border-base-300/60 bg-base-100 p-3 transition-colors hover:bg-base-200/40"
						>
							<div class="flex items-start justify-between gap-2">
								<div class="flex items-center gap-1.5 text-xs uppercase tracking-wide text-base-content/50">
									<i class="mdi mdi-magnify text-sm"></i>
									Research
								</div>
								{#if isInFlight(item.status) || item.status === 'failed'}
									<span class="badge badge-xs {statusTone(item.status)}">
										{item.status}{isInFlight(item.status) ? '…' : ''}
									</span>
								{/if}
							</div>
							<p class="line-clamp-2 font-medium leading-tight">{item.title}</p>
							{#if item.preview}
								<p class="line-clamp-3 text-xs text-base-content/60">{item.preview}</p>
							{/if}
							<div class="mt-auto flex flex-wrap items-center gap-2 text-[11px] text-base-content/50">
								<span>{relativeTime(item.createdAt)}</span>
								{#if parseFloat(item.costUsd) > 0}
									<span>· ${parseFloat(item.costUsd).toFixed(4)}</span>
								{/if}
							</div>
						</a>
					{:else if item.kind === 'image'}
						<button
							type="button"
							class="flex h-full w-full flex-col gap-1.5 rounded-xl border border-base-300/60 bg-base-100 p-3 text-left transition-colors hover:bg-base-200/40"
							onclick={() => openLightbox(item)}
						>
							<div class="flex items-center gap-1.5 text-xs uppercase tracking-wide text-base-content/50">
								<i class="mdi mdi-image-outline text-sm"></i>
								Image
							</div>
							<div class="aspect-video w-full overflow-hidden rounded-md bg-base-200/40">
								<img
									src={item.url}
									alt={item.title}
									class="h-full w-full object-cover"
									loading="lazy"
								/>
							</div>
							<p class="line-clamp-2 text-xs text-base-content/70">{item.title}</p>
							<div class="mt-auto flex flex-wrap items-center gap-2 text-[11px] text-base-content/50">
								<span>{relativeTime(item.createdAt)}</span>
								{#if item.size}<span>· {item.size}</span>{/if}
								{#if item.costUsd && parseFloat(item.costUsd) > 0}
									<span>· ${parseFloat(item.costUsd).toFixed(4)}</span>
								{/if}
							</div>
						</button>
					{:else}
						<a
							href={item.href}
							class="flex h-full flex-col gap-1.5 rounded-xl border border-base-300/60 bg-base-100 p-3 transition-colors hover:bg-base-200/40"
						>
							<div class="flex items-start justify-between gap-2">
								<div class="flex items-center gap-1.5 text-xs uppercase tracking-wide text-base-content/50">
									<i class="mdi mdi-file-document-outline text-sm"></i>
									Document
								</div>
								<span class="badge badge-xs badge-ghost">{item.contentType}</span>
							</div>
							<p class="line-clamp-2 font-medium leading-tight">{item.title}</p>
							{#if item.preview}
								<p class="line-clamp-3 text-xs text-base-content/60">{item.preview}</p>
							{/if}
							<div class="mt-auto flex flex-wrap items-center gap-2 text-[11px] text-base-content/50">
								<span>{relativeTime(item.createdAt)}</span>
								<span>· in {item.projectName}</span>
							</div>
						</a>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>

<!-- Lightbox for image preview -->
<dialog bind:this={lightboxDialog} class="modal" onclose={() => (lightboxImage = null)}>
	<div class="modal-box max-w-5xl bg-base-100">
		{#if lightboxImage}
			<div class="flex flex-col gap-3">
				<div class="flex items-start justify-between gap-3">
					<div class="min-w-0 flex-1">
						<p class="text-xs uppercase tracking-wide text-base-content/50">Image prompt</p>
						<p class="mt-0.5 text-sm">{lightboxImage.title}</p>
					</div>
					<button class="btn btn-sm btn-ghost btn-circle" onclick={closeLightbox} aria-label="Close">
						<i class="mdi mdi-close"></i>
					</button>
				</div>
				<div class="flex max-h-[70vh] items-center justify-center overflow-auto rounded-lg bg-base-200/40">
					<img
						src={lightboxImage.url}
						alt={lightboxImage.title}
						class="max-h-[70vh] w-auto object-contain"
					/>
				</div>
				<div class="flex flex-wrap items-center gap-3 text-xs text-base-content/55">
					<span>{lightboxImage.model}</span>
					{#if lightboxImage.size}<span>· {lightboxImage.size}</span>{/if}
					{#if lightboxImage.costUsd && parseFloat(lightboxImage.costUsd) > 0}
						<span>· ${parseFloat(lightboxImage.costUsd).toFixed(4)}</span>
					{/if}
					<span>· {relativeTime(lightboxImage.createdAt)}</span>
					<a class="link link-primary ml-auto" href={lightboxImage.url} target="_blank" rel="noreferrer noopener">
						Open original
					</a>
				</div>
			</div>
		{/if}
	</div>
	<form method="dialog" class="modal-backdrop">
		<button>close</button>
	</form>
</dialog>
