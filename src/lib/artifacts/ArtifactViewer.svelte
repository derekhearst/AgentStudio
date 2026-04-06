<script lang="ts">
	import { renderMarkdown } from '$lib/chat/chat';

	type ArtifactData = {
		id: string;
		type: string;
		title: string;
		content: string;
		language: string | null;
		mimeType: string | null;
		url: string | null;
		pinned: boolean;
	};

	let {
		artifact,
		onClose,
		onToggleFullscreen,
		onPin,
		isFullscreen = false,
	}: {
		artifact: ArtifactData;
		onClose?: () => void;
		onToggleFullscreen?: () => void;
		onPin?: (id: string, pinned: boolean) => void;
		isFullscreen?: boolean;
	} = $props();

	let copied = $state(false);

	const renderedMarkdown = $derived(
		artifact.type === 'markdown' ? renderMarkdown(artifact.content) : ''
	);

	const highlightedCode = $derived(
		artifact.type === 'code' || artifact.type === 'config'
			? renderMarkdown('```' + (artifact.language ?? '') + '\n' + artifact.content + '\n```')
			: ''
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

	const typeColor = $derived(
		({
			markdown: 'badge-primary',
			code: 'badge-success',
			config: 'badge-warning',
			image: 'badge-info',
			svg: 'badge-accent',
			mermaid: 'badge-secondary',
			html: 'badge-info',
			svelte: 'badge-error',
			data_table: 'badge-primary',
			chart: 'badge-accent',
			audio: 'badge-info',
			video: 'badge-info',
		} as Record<string, string>)[artifact.type] ?? 'badge-neutral'
	);

	async function copyContent() {
		try {
			await navigator.clipboard.writeText(artifact.content);
			copied = true;
			setTimeout(() => {
				copied = false;
			}, 2000);
		} catch {
			// Clipboard API may not be available
		}
	}

	function downloadArtifact() {
		const ext =
			({
				markdown: '.md',
				code: artifact.language ? `.${artifact.language}` : '.txt',
				config: artifact.language === 'json' ? '.json' : artifact.language === 'yaml' ? '.yaml' : '.toml',
				image: '.png',
				svg: '.svg',
				mermaid: '.mmd',
				html: '.html',
				svelte: '.svelte',
				data_table: '.json',
				chart: '.json',
				audio: '.mp3',
				video: '.mp4',
			} as Record<string, string>)[artifact.type] ?? '.txt';

		const blob = new Blob([artifact.content], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = artifact.title.replace(/[^a-zA-Z0-9_-]/g, '_') + ext;
		a.click();
		URL.revokeObjectURL(url);
	}
</script>

<div class="flex h-full flex-col overflow-hidden rounded-2xl border border-base-300 bg-base-100">
	<!-- Toolbar -->
	<div class="flex shrink-0 items-center gap-2 border-b border-base-300 px-4 py-2">
		<span class={`badge badge-sm ${typeColor}`}>{typeLabel}</span>
		<h2 class="min-w-0 flex-1 truncate text-sm font-semibold">{artifact.title}</h2>

		{#if artifact.language}
			<span class="text-xs opacity-60">{artifact.language}</span>
		{/if}

		<div class="flex items-center gap-1">
			<button
				class="btn btn-ghost btn-xs btn-circle"
				type="button"
				onclick={copyContent}
				title="Copy content"
			>
				{#if copied}
					<svg viewBox="0 0 24 24" class="h-3.5 w-3.5 text-success" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>
				{:else}
					<svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
				{/if}
			</button>

			<button
				class="btn btn-ghost btn-xs btn-circle"
				type="button"
				onclick={downloadArtifact}
				title="Download"
			>
				<svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
			</button>

			<button
				class="btn btn-ghost btn-xs btn-circle"
				type="button"
				onclick={() => onPin?.(artifact.id, !artifact.pinned)}
				title={artifact.pinned ? 'Unpin' : 'Pin'}
			>
				<svg viewBox="0 0 24 24" class={`h-3.5 w-3.5 ${artifact.pinned ? 'fill-warning text-warning' : ''}`} fill="none" stroke="currentColor" stroke-width="2">
					<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"></path>
				</svg>
			</button>

			<button
				class="btn btn-ghost btn-xs btn-circle"
				type="button"
				onclick={onToggleFullscreen}
				title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
			>
				{#if isFullscreen}
					<svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 14 10 14 10 20"></polyline><polyline points="20 10 14 10 14 4"></polyline><line x1="14" y1="10" x2="21" y2="3"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>
				{:else}
					<svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>
				{/if}
			</button>

			<button
				class="btn btn-ghost btn-xs btn-circle"
				type="button"
				onclick={onClose}
				title="Close"
			>
				<svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
			</button>
		</div>
	</div>

	<!-- Content -->
	<div class="min-h-0 flex-1 overflow-auto p-4">
		{#if artifact.type === 'markdown'}
			<div class="markdown-body">{@html renderedMarkdown}</div>

		{:else if artifact.type === 'code' || artifact.type === 'config'}
			<div class="markdown-body">{@html highlightedCode}</div>

		{:else if artifact.type === 'image'}
			{#if artifact.url}
				<div class="flex items-center justify-center">
					<img
						src={artifact.url}
						alt={artifact.title}
						class="max-h-full max-w-full rounded-lg object-contain"
					/>
				</div>
			{:else if artifact.content}
				<div class="flex items-center justify-center">
					<img
						src={artifact.content}
						alt={artifact.title}
						class="max-h-full max-w-full rounded-lg object-contain"
					/>
				</div>
			{/if}

		{:else if artifact.type === 'svg'}
			<div class="flex items-center justify-center">
				{@html artifact.content}
			</div>

		{:else if artifact.type === 'html'}
			<iframe
				srcdoc={artifact.content}
				sandbox="allow-scripts"
				class="h-full w-full rounded-lg border border-base-300"
				title={artifact.title}
			></iframe>

		{:else if artifact.type === 'audio'}
			<div class="flex items-center justify-center pt-8">
				<audio controls src={artifact.url ?? artifact.content} class="w-full max-w-lg">
					<track kind="captions" />
				</audio>
			</div>

		{:else if artifact.type === 'video'}
			<div class="flex items-center justify-center">
				<video controls src={artifact.url ?? artifact.content} class="max-h-full max-w-full rounded-lg">
					<track kind="captions" />
				</video>
			</div>

		{:else if artifact.type === 'data_table'}
			{@const rows = (() => { try { return JSON.parse(artifact.content) } catch { return [] } })()}
			{#if Array.isArray(rows) && rows.length > 0}
				<div class="overflow-x-auto">
					<table class="table table-zebra table-sm">
						<thead>
							<tr>
								{#each Object.keys(rows[0]) as key}
									<th>{key}</th>
								{/each}
							</tr>
						</thead>
						<tbody>
							{#each rows as row}
								<tr>
									{#each Object.values(row) as val}
										<td>{String(val)}</td>
									{/each}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{:else}
				<p class="text-sm opacity-70">No table data.</p>
			{/if}

		{:else if artifact.type === 'mermaid'}
			<!-- Mermaid rendered lazily in Phase 2+ -->
			<pre class="overflow-x-auto rounded-lg bg-base-200 p-4 text-sm">{artifact.content}</pre>

		{:else if artifact.type === 'svelte'}
			<!-- Svelte iframe rendered in Phase 7 -->
			<pre class="overflow-x-auto rounded-lg bg-base-200 p-4 text-sm">{artifact.content}</pre>

		{:else}
			<pre class="overflow-x-auto whitespace-pre-wrap text-sm">{artifact.content}</pre>
		{/if}
	</div>
</div>

