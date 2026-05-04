<svelte:head><title>{detail?.artifact.name ?? 'Artifact'} | AgentStudio</title></svelte:head>

<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import {
		getArtifactQuery,
		editArtifactCommand,
		rollbackArtifactCommand,
	} from '$lib/projects/projects.remote';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';

	type Detail = NonNullable<Awaited<ReturnType<typeof getArtifactQuery>>>;

	const projectId = $derived(page.params.id ?? '');
	const artifactId = $derived(page.params.aid ?? '');

	let detail = $state<Detail | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);

	let viewingSeq = $state<number | null>(null);
	let editing = $state(false);
	let editContent = $state('');
	let editChangeNote = $state('');
	let editError = $state<string | null>(null);
	let saving = $state(false);

	const viewedVersion = $derived(
		detail && viewingSeq !== null
			? detail.versions.find((v) => v.seq === viewingSeq) ?? null
			: detail?.versions[detail.versions.length - 1] ?? null,
	);
	const isViewingLatest = $derived(
		detail && (viewingSeq === null || viewingSeq === detail.versions[detail.versions.length - 1]?.seq),
	);

	onMount(() => void load());

	async function load() {
		loading = true;
		error = null;
		try {
			detail = await getArtifactQuery(artifactId);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load artifact';
		} finally {
			loading = false;
		}
	}

	function startEdit() {
		if (!viewedVersion) return;
		editContent = viewedVersion.content;
		editChangeNote = '';
		editError = null;
		editing = true;
	}

	function cancelEdit() {
		editing = false;
		editContent = '';
		editChangeNote = '';
		editError = null;
	}

	async function submitEdit(event: Event) {
		event.preventDefault();
		saving = true;
		editError = null;
		try {
			await editArtifactCommand({
				artifactId,
				content: editContent,
				changeNote: editChangeNote.trim() || undefined,
			});
			editing = false;
			viewingSeq = null;
			await load();
		} catch (e) {
			editError = e instanceof Error ? e.message : 'Failed to save edit';
		} finally {
			saving = false;
		}
	}

	async function handleRollback(toSeq: number) {
		if (!confirm(`Rollback to v${toSeq}? A new version is created with v${toSeq}'s content; older versions are preserved.`)) return;
		try {
			await rollbackArtifactCommand({ artifactId, toSeq, changeNote: `Rollback to v${toSeq}` });
			viewingSeq = null;
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to roll back';
		}
	}

	function fmtDate(d: Date | string) {
		return new Date(d).toLocaleString();
	}
</script>

{#if loading}
	<div class="flex justify-center py-20">
		<span class="loading loading-spinner loading-lg text-primary"></span>
	</div>
{:else if error || !detail}
	<div class="py-20 text-center text-sm text-base-content/55">{error ?? 'Artifact not found.'}</div>
{:else}
	{@const a = detail.artifact}
	<section class="space-y-3 sm:space-y-4">
		<a class="btn btn-sm btn-ghost -ml-1 w-fit" href="/projects/{projectId}">← Back to project</a>

		<ContentPanel>
			{#snippet header()}
				<div class="flex flex-1 flex-wrap items-start justify-between gap-2">
					<div class="min-w-0 flex-1">
						<h1 class="text-lg font-bold leading-tight sm:text-2xl">{a.name}</h1>
						<p class="mt-0.5 font-mono text-xs text-base-content/55">
							/{a.slug} · {a.contentType} · {detail?.versions.length ?? 0} version{(detail?.versions.length ?? 0) === 1 ? '' : 's'}
						</p>
					</div>
					{#if !editing && isViewingLatest}
						<button class="btn btn-sm btn-primary" type="button" onclick={startEdit}>Edit</button>
					{/if}
				</div>
			{/snippet}
		</ContentPanel>

		<div class="grid gap-3 lg:grid-cols-[1fr_280px]">
			<ContentPanel>
				{#snippet header()}
					<div class="flex flex-1 items-center justify-between gap-2">
						<h2 class="font-semibold">
							{#if editing}
								New version (v{(detail?.versions.length ?? 0) + 1})
							{:else if viewedVersion}
								v{viewedVersion.seq}
								{#if viewedVersion.changeNote}
									<span class="ml-2 text-xs font-normal text-base-content/55">— {viewedVersion.changeNote}</span>
								{/if}
							{/if}
						</h2>
						{#if !editing && viewedVersion}
							<span class="font-mono text-[10px] text-base-content/40">{fmtDate(viewedVersion.createdAt)}</span>
						{/if}
					</div>
				{/snippet}

				{#if editing}
					<form class="grid gap-2" onsubmit={submitEdit}>
						<textarea
							class="textarea textarea-bordered min-h-72 font-mono text-xs"
							bind:value={editContent}
							placeholder="Edit content here…"
						></textarea>
						<input
							type="text"
							class="input input-sm input-bordered"
							bind:value={editChangeNote}
							placeholder="Change note (optional, e.g. 'add waterproofing section')"
							maxlength="500"
						/>
						{#if editError}
							<div class="alert alert-error py-2 text-xs">{editError}</div>
						{/if}
						<div class="flex justify-end gap-2">
							<button type="button" class="btn btn-xs btn-ghost" onclick={cancelEdit} disabled={saving}>
								Cancel
							</button>
							<button type="submit" class="btn btn-xs btn-primary" disabled={saving}>
								{saving ? 'Saving…' : 'Save as v' + ((detail?.versions.length ?? 0) + 1)}
							</button>
						</div>
					</form>
				{:else if viewedVersion}
					<pre class="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg bg-base-200/50 p-3 font-mono text-xs leading-relaxed">{viewedVersion.content}</pre>
				{/if}
			</ContentPanel>

			<ContentPanel>
				{#snippet header()}
					<h3 class="font-semibold">Version history</h3>
				{/snippet}
				<ul class="space-y-1">
					{#each [...detail.versions].reverse() as v (v.id)}
						{@const isLatest = v.seq === detail.versions[detail.versions.length - 1].seq}
						{@const isViewed = (viewingSeq ?? detail.versions[detail.versions.length - 1].seq) === v.seq}
						<li>
							<button
								type="button"
								class="flex w-full flex-col gap-0.5 rounded-lg border px-2.5 py-2 text-left text-xs transition-colors {isViewed ? 'border-primary/55 bg-primary/10' : 'border-base-300/60 bg-base-100 hover:bg-base-200/40'}"
								onclick={() => (viewingSeq = v.seq)}
							>
								<div class="flex items-center justify-between gap-2">
									<span class="font-mono font-semibold">v{v.seq}</span>
									{#if isLatest}<span class="badge badge-xs badge-success">latest</span>{/if}
								</div>
								{#if v.changeNote}
									<span class="line-clamp-2 text-[11px] leading-snug text-base-content/65">{v.changeNote}</span>
								{/if}
								<span class="font-mono text-[10px] text-base-content/40">{fmtDate(v.createdAt)}</span>
							</button>
							{#if !isLatest && isViewed}
								<button
									class="btn btn-xs btn-ghost mt-1 w-full"
									type="button"
									onclick={() => handleRollback(v.seq)}
								>
									Rollback to v{v.seq}
								</button>
							{/if}
						</li>
					{/each}
				</ul>
			</ContentPanel>
		</div>
	</section>
{/if}
