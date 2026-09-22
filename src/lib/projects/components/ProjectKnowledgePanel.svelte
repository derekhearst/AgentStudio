<script lang="ts">
	import { listProjectKnowledgeQuery } from '$lib/projects/projects.remote';

	/**
	 * #23 — reference material attached to a project.
	 *
	 * Files live at `.agentstudio/knowledge/` inside the project's working directory, so the
	 * agent reads them with the same tools it uses for source — there is no retrieval layer
	 * and nothing to keep in sync. The panel names them in the system prompt's project slot;
	 * this is where they get there.
	 *
	 * Uploads go over `/projects/[id]/knowledge` rather than a remote function, because
	 * remote functions carry JSON and these are arbitrary bytes.
	 */

	let { projectId }: { projectId: string } = $props();

	type KnowledgeFile = { name: string; size: number; modifiedAt: string };

	let files = $state<KnowledgeFile[]>([]);
	let loading = $state(true);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let fileInput = $state<HTMLInputElement | null>(null);

	$effect(() => {
		void refresh(projectId);
	});

	async function refresh(id: string) {
		loading = true;
		try {
			files = await listProjectKnowledgeQuery(id);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not list this project’s knowledge';
		} finally {
			loading = false;
		}
	}

	async function upload(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const chosen = Array.from(input.files ?? []);
		if (chosen.length === 0) return;

		busy = true;
		error = null;
		try {
			// One at a time: a per-file refusal (too large, refused extension, project full)
			// should stop at that file and keep the ones before it, not fail the batch.
			for (const file of chosen) {
				const body = new FormData();
				body.set('file', file);
				const response = await fetch(`/projects/${projectId}/knowledge`, { method: 'POST', body });
				if (!response.ok) {
					const payload = (await response.json().catch(() => null)) as { error?: string } | null;
					throw new Error(payload?.error ?? `Could not upload ${file.name}`);
				}
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Upload failed';
		} finally {
			busy = false;
			// Cleared either way, so choosing the same file again re-fires `change`.
			if (fileInput) fileInput.value = '';
			await listProjectKnowledgeQuery(projectId).refresh();
			await refresh(projectId);
		}
	}

	async function remove(name: string) {
		busy = true;
		error = null;
		try {
			const response = await fetch(`/projects/${projectId}/knowledge`, {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name })
			});
			if (!response.ok) {
				const payload = (await response.json().catch(() => null)) as { error?: string } | null;
				throw new Error(payload?.error ?? `Could not remove ${name}`);
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not remove that file';
		} finally {
			busy = false;
			await listProjectKnowledgeQuery(projectId).refresh();
			await refresh(projectId);
		}
	}

	function formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
		return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	}
</script>

<div class="rounded-lg border border-base-300 bg-base-200/40 p-3" data-testid="project-knowledge">
	<div class="flex flex-wrap items-center gap-2">
		<span class="text-sm font-medium">Project knowledge</span>
		{#if files.length > 0}
			<span class="badge badge-sm badge-ghost">{files.length}</span>
		{/if}
	</div>

	<p class="mt-1.5 text-xs text-base-content/70">
		Reference material that is not part of the repo — a spec, an export, a datasheet. Stored in
		<code>.agentstudio/knowledge/</code> inside this project's working directory, listed by name in
		the agent's prompt, and read with the ordinary file tools when relevant.
	</p>

	{#if error}
		<p class="mt-1.5 text-xs text-error">{error}</p>
	{/if}

	{#if loading}
		<p class="mt-2 text-xs text-base-content/45">Loading…</p>
	{:else if files.length === 0}
		<p class="mt-2 text-xs text-base-content/45">Nothing attached yet.</p>
	{:else}
		<ul class="mt-2 divide-y divide-base-300/60 rounded border border-base-300/60">
			{#each files as file (file.name)}
				<li class="flex items-center gap-2 px-2 py-1.5">
					<span class="min-w-0 flex-1 truncate font-mono text-xs" title={file.name}>{file.name}</span>
					<span class="shrink-0 text-xs text-base-content/45">{formatSize(file.size)}</span>
					<button
						class="btn btn-ghost btn-xs shrink-0"
						type="button"
						disabled={busy}
						aria-label={`Remove ${file.name}`}
						onclick={() => remove(file.name)}
					>
						Remove
					</button>
				</li>
			{/each}
		</ul>
	{/if}

	<div class="mt-2">
		<input
			bind:this={fileInput}
			class="file-input file-input-bordered file-input-xs w-full max-w-xs"
			type="file"
			multiple
			disabled={busy}
			aria-label="Add knowledge files"
			onchange={upload}
		/>
	</div>
</div>
