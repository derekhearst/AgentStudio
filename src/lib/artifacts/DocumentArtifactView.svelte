<script lang="ts">
	import { getArtifactQuery, getVersionQuery } from '$lib/projects/projects.remote';
	import { renderMarkdown } from '$lib/chat/chat';

	let { artifactId }: { artifactId: string } = $props();

	type ArtifactBundle = Awaited<ReturnType<typeof getArtifactQuery>>;
	type Version = NonNullable<Awaited<ReturnType<typeof getVersionQuery>>>;

	let bundle = $state<ArtifactBundle | null>(null);
	let currentVersion = $state<Version | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);

	$effect(() => {
		const id = artifactId;
		bundle = null;
		currentVersion = null;
		loading = true;
		error = null;
		void load(id);
	});

	async function load(id: string) {
		try {
			bundle = await getArtifactQuery(id);
			if (!bundle) {
				error = 'Artifact not found.';
				return;
			}
			const versionId = bundle.artifact.currentVersionId;
			if (versionId) {
				currentVersion = await getVersionQuery(versionId);
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load artifact';
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
{:else if error || !bundle}
	<div class="py-20 text-center text-sm text-base-content/55">{error ?? 'Artifact not found.'}</div>
{:else}
	{@const a = bundle.artifact}
	{@const seq = currentVersion?.seq ?? bundle.versions.at(0)?.seq ?? 1}
	{@const updatedAt = currentVersion?.createdAt ?? a.updatedAt}
	<div class="flex h-full min-h-0 flex-col">
		<header class="border-b border-base-300/60 px-4 py-3">
			<div class="flex items-start justify-between gap-2">
				<div class="min-w-0 flex-1">
					<h2 class="line-clamp-2 text-base font-semibold leading-tight">{a.name}</h2>
					<div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-base-content/55">
						<span class="badge badge-xs badge-ghost">{a.contentType}</span>
						<span>· v{seq}</span>
						<span>· edited {fmtDate(updatedAt)}</span>
					</div>
				</div>
			</div>
		</header>

		<div class="flex-1 overflow-y-auto p-4">
			{#if !currentVersion}
				<p class="py-6 text-center text-sm italic text-base-content/45">No version content available.</p>
			{:else if a.contentType === 'markdown'}
				<div class="markdown-body">{@html renderMarkdown(currentVersion.content)}</div>
			{:else}
				<pre
					class="overflow-x-auto whitespace-pre-wrap rounded-lg bg-base-200/30 p-3 font-mono text-xs leading-relaxed">{currentVersion.content}</pre>
			{/if}

			{#if currentVersion?.changeNote}
				<p class="mt-3 text-xs italic text-base-content/55">
					<span class="font-semibold">Change note:</span> {currentVersion.changeNote}
				</p>
			{/if}
		</div>

		<footer class="border-t border-base-300/60 px-4 py-2 text-xs text-base-content/55">
			<a class="link link-hover" href="/projects/{a.projectId}/artifacts/{a.id}">Open full page →</a>
		</footer>
	</div>
{/if}
