<script lang="ts">
	import { getImageQuery } from '$lib/images/images.remote';

	let { id }: { id: string } = $props();

	type Image = NonNullable<Awaited<ReturnType<typeof getImageQuery>>>;

	let image = $state<Image | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);

	$effect(() => {
		const imageId = id;
		image = null;
		loading = true;
		error = null;
		void load(imageId);
	});

	async function load(imageId: string) {
		try {
			image = await getImageQuery(imageId);
			if (!image) error = 'Image not found.';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load image';
		} finally {
			loading = false;
		}
	}

	function fmtDate(d: Date | string | null) {
		if (!d) return '—';
		return new Date(d).toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
		});
	}
</script>

{#if loading}
	<div class="flex justify-center py-20">
		<span class="loading loading-spinner loading-lg text-primary"></span>
	</div>
{:else if error || !image}
	<div class="py-20 text-center text-sm text-base-content/55">{error ?? 'Image not found.'}</div>
{:else}
	<div class="flex h-full min-h-0 flex-col">
		<header class="border-b border-base-300/60 px-4 py-3">
			<div class="min-w-0 flex-1">
				<p class="text-xs uppercase tracking-wide text-base-content/50">Image prompt</p>
				<p class="mt-0.5 line-clamp-2 text-sm">{image.prompt}</p>
			</div>
		</header>

		<div class="flex-1 overflow-y-auto p-4">
			<div class="flex items-center justify-center overflow-hidden rounded-lg bg-base-200/40">
				<img
					src={image.url}
					alt={image.prompt}
					class="max-h-[70vh] w-auto max-w-full object-contain"
				/>
			</div>

			<div class="mt-3 flex flex-wrap items-center gap-2 text-xs text-base-content/60">
				<span class="font-mono">{image.model}</span>
				{#if image.size}<span>· {image.size}</span>{/if}
				{#if image.costUsd && parseFloat(String(image.costUsd)) > 0}
					<span>· ${parseFloat(String(image.costUsd)).toFixed(4)}</span>
				{/if}
				<span>· {fmtDate(image.createdAt)}</span>
			</div>
		</div>

		<footer class="border-t border-base-300/60 px-4 py-2 text-xs text-base-content/55">
			<a class="link link-hover" href={image.url} target="_blank" rel="noreferrer noopener">
				Open original →
			</a>
		</footer>
	</div>
{/if}
