<script lang="ts">
	import { renderMarkdown } from '$lib/chat/chat'

	type Focus = 'plan' | 'todo' | 'document' | 'data'

	let {
		artifactId,
		name,
		contentType = 'markdown',
		versionSeq,
		content,
		focus = null,
		note = null,
	} = $props<{
		artifactId: string
		name: string
		contentType?: 'markdown' | 'code' | 'json' | 'yaml' | 'plaintext'
		versionSeq: number
		content: string
		focus?: Focus | null
		note?: string | null
	}>()

	const focusLabel = $derived.by(() => {
		switch (focus) {
			case 'plan':
				return 'Plan'
			case 'todo':
				return 'Todo'
			case 'data':
				return 'Data'
			case 'document':
				return 'Document'
			default:
				return 'Artifact'
		}
	})

	const focusBadge = $derived.by(() => {
		switch (focus) {
			case 'plan':
				return 'badge-info'
			case 'todo':
				return 'badge-warning'
			case 'data':
				return 'badge-accent'
			case 'document':
				return 'badge-neutral'
			default:
				return 'badge-ghost'
		}
	})

	const renderedMarkdown = $derived(contentType === 'markdown' ? renderMarkdown(content) : null)
</script>

<article class="artifact-card chat chat-start w-full">
	<div class="card card-body w-full max-w-full rounded-2xl border border-base-300/70 bg-base-100/80 px-4 py-3">
		<header class="mb-2 flex items-center gap-2 text-sm">
			<span class={`badge badge-sm ${focusBadge}`}>{focusLabel}</span>
			<span class="font-medium leading-tight">{name}</span>
			<span class="badge badge-xs badge-ghost ml-1 font-mono">v{versionSeq}</span>
			<a
				href={`/artifacts/${artifactId}`}
				class="link link-hover ml-auto text-xs text-base-content/60"
				title="Open artifact in drawer"
			>
				Open →
			</a>
		</header>

		{#if note}
			<p class="mb-2 text-xs leading-snug text-base-content/70">{note}</p>
		{/if}

		<div class="artifact-content rounded-xl border border-base-300/40 bg-base-200/40 px-3 py-2 text-sm">
			{#if contentType === 'markdown' && renderedMarkdown}
				<div class="prose prose-sm max-w-none dark:prose-invert">
					{@html renderedMarkdown}
				</div>
			{:else}
				<pre class="overflow-x-auto whitespace-pre-wrap break-words text-xs leading-snug">{content}</pre>
			{/if}
		</div>
	</div>
</article>

<style>
	.artifact-content :global(pre) {
		margin: 0;
	}
</style>
