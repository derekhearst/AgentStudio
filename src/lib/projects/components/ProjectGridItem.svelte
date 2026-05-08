<script lang="ts">
	import type { listProjectsQuery } from '$lib/projects/projects.remote'

	type ProjectRow = Awaited<ReturnType<typeof listProjectsQuery>>[number]

	let { project, onDelete } = $props<{
		project: ProjectRow
		onDelete: (project: ProjectRow) => void
	}>()

	function fmtDate(d: Date | string): string {
		return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
	}

	function kindTone(kind: string): string {
		switch (kind) {
			case 'code': return 'badge-info'
			case 'research': return 'badge-secondary'
			case 'documentation': return 'badge-warning'
			case 'efoil': return 'badge-primary'
			default: return 'badge-ghost'
		}
	}

	function repoBadge(repoKind: string) {
		if (repoKind === 'local') return { tone: 'badge-ghost', label: 'local' }
		if (repoKind === 'imported') return { tone: 'badge-success', label: 'imported' }
		return null
	}

	const rb = $derived(repoBadge(project.repoKind))
</script>

<div class="group flex flex-col gap-2 rounded-xl border border-base-300/60 bg-base-100 p-3 transition-colors hover:bg-base-200/40">
	<div class="flex items-start justify-between gap-2">
		<a href="/projects/{project.id}" class="min-w-0 flex-1">
			<p class="line-clamp-1 font-semibold leading-tight">{project.name}</p>
			<p class="font-mono text-[10px] text-base-content/50">/{project.slug}</p>
		</a>
		<div class="flex flex-col items-end gap-1">
			<span class="badge badge-xs {kindTone(project.kind)}">{project.kind}</span>
			{#if rb}
				<span class="badge badge-xs {rb.tone}">{rb.label}</span>
			{/if}
		</div>
	</div>
	{#if project.description}
		<p class="line-clamp-2 text-xs text-base-content/65">{project.description}</p>
	{/if}
	<div class="flex items-center justify-between text-xs text-base-content/45">
		<span>Updated {fmtDate(project.updatedAt)}</span>
		<button
			class="btn btn-xs btn-ghost text-error opacity-50 hover:opacity-100"
			type="button"
			onclick={() => onDelete(project)}
			aria-label="Delete project"
		>
			Delete
		</button>
	</div>
</div>
