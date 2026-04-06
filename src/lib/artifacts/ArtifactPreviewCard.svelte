<script lang="ts">
	type ArtifactPreview = {
		id: string;
		type: string;
		title: string;
		content: string;
		language: string | null;
	};

	let {
		artifact,
		onOpen,
	}: {
		artifact: ArtifactPreview;
		onOpen?: (id: string) => void;
	} = $props();

	const typeIcon = $derived(
		({
			markdown: '📄',
			code: '💻',
			config: '⚙️',
			image: '🖼️',
			svg: '🎨',
			mermaid: '📊',
			html: '🌐',
			svelte: '🧩',
			data_table: '📋',
			chart: '📈',
			audio: '🎵',
			video: '🎬',
		} as Record<string, string>)[artifact.type] ?? '📎'
	);

	const typeLabel = $derived(
		({
			markdown: 'Document',
			code: 'Code',
			config: 'Config',
			image: 'Image',
			svg: 'SVG',
			mermaid: 'Diagram',
			html: 'HTML',
			svelte: 'Component',
			data_table: 'Table',
			chart: 'Chart',
			audio: 'Audio',
			video: 'Video',
		} as Record<string, string>)[artifact.type] ?? artifact.type
	);

	const preview = $derived(
		artifact.content.length > 120
			? artifact.content.slice(0, 120) + '…'
			: artifact.content
	);
</script>

<button
	type="button"
	class="mt-2 flex w-full items-start gap-3 rounded-xl border border-base-300 bg-base-200/50 p-3 text-left transition-colors hover:bg-base-200"
	onclick={() => onOpen?.(artifact.id)}
>
	<span class="mt-0.5 text-lg">{typeIcon}</span>
	<div class="min-w-0 flex-1">
		<div class="flex items-center gap-2">
			<span class="truncate text-sm font-medium">{artifact.title}</span>
			<span class="badge badge-xs badge-ghost">{typeLabel}</span>
			{#if artifact.language}
				<span class="text-xs opacity-50">{artifact.language}</span>
			{/if}
		</div>
		<p class="mt-0.5 line-clamp-2 text-xs opacity-60">{preview}</p>
	</div>
	<span class="mt-1 text-xs opacity-40">Open →</span>
</button>
