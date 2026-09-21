<script lang="ts">
	import Icon from './Icon.svelte';
	import { readPreviewFile } from './preview.remote';
	import { formatBytes, looksLikePath, normalizePreviewUrl } from './preview-kinds';
	import { lineNumbers, renderPreviewCode, renderPreviewMarkdown } from './preview-render';
	import {
		clearPreview,
		confirmProposedUrl,
		dismissProposedUrl,
		goBack,
		openFilePreview,
		openUrlPreview,
		previewState,
	} from './preview-state.svelte';

	let { conversationId }: { conversationId: string | null } = $props();

	let address = $state('');
	let addressError = $state<string | null>(null);

	const selection = $derived(previewState.selection);

	const fileQuery = $derived.by(() => {
		if (selection.kind !== 'file' || !conversationId) return null;
		try {
			return readPreviewFile({ conversationId, path: selection.path });
		} catch {
			return null;
		}
	});

	const fileResult = $derived(fileQuery ? fileQuery.current : undefined);

	/** Rendered HTML for markdown / highlighted code. Filled by the effect below. */
	let renderedHtml = $state<string | null>(null);
	// Plain `let`, not `$state` — it is a dedupe guard the effect both reads and
	// writes, and making it reactive would make the effect depend on itself.
	let renderedFor: string | null = null;

	$effect(() => {
		const result = fileResult;
		if (!result || !result.ok || result.payload.kind === 'directory') {
			renderedHtml = null;
			renderedFor = null;
			return;
		}
		const payload = result.payload;
		if (payload.content === null) {
			renderedHtml = null;
			renderedFor = null;
			return;
		}
		const key = `${payload.path}:${payload.kind}:${payload.size}:${payload.modifiedAt ?? ''}`;
		if (renderedFor === key) return;

		let cancelled = false;
		const content = payload.content;
		const run = async () => {
			if (payload.kind === 'markdown') {
				return renderPreviewMarkdown(content, { conversationId, filePath: payload.path });
			}
			if (payload.kind === 'code') {
				return renderPreviewCode(content, payload.language);
			}
			return null;
		};
		void run().then((html) => {
			if (cancelled) return;
			renderedHtml = html;
			renderedFor = key;
		});
		return () => {
			cancelled = true;
		};
	});

	function submitAddress(event: SubmitEvent) {
		event.preventDefault();
		const raw = address.trim();
		if (!raw) return;
		addressError = null;
		if (looksLikePath(raw)) {
			openFilePreview(raw);
			address = '';
			return;
		}
		if (openUrlPreview(raw)) {
			address = '';
			return;
		}
		addressError = 'Only http:// and https:// URLs, or a workspace file path.';
	}

	/**
	 * `allow-same-origin` is granted only for a cross-origin target. A page on our
	 * own origin (the app itself, or a dev server that happens to share it) would
	 * otherwise be able to script us straight out of the sandbox.
	 */
	const iframeSandbox = $derived.by(() => {
		const base = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals';
		if (selection.kind !== 'url') return base;
		try {
			const target = new URL(selection.url);
			if (typeof window !== 'undefined' && target.origin === window.location.origin) return base;
			return `${base} allow-same-origin`;
		} catch {
			return base;
		}
	});

	const externalUrl = $derived(selection.kind === 'url' ? normalizePreviewUrl(selection.url) : null);
</script>

<div class="console-prev">
	<form class="console-prev__address" onsubmit={submitAddress}>
		<span class="console-prev__address-icon"><Icon name="search" size={12} /></span>
		<input
			type="text"
			bind:value={address}
			placeholder="File path, or https:// URL"
			spellcheck="false"
			autocapitalize="off"
			autocorrect="off"
			aria-label="Open a file path or URL in the preview"
		/>
		<button type="submit" class="console-prev__go">Open</button>
	</form>
	{#if addressError}
		<p class="console-prev__err">{addressError}</p>
	{/if}

	{#if previewState.proposed}
		<!--
			A URL that came out of a tool result. It is attacker-influenced data, so
			it is displayed in full and loads only on an explicit click.
		-->
		<div class="console-prev__propose">
			<div class="console-prev__propose-head">
				<Icon name="alert" size={12} />
				<span>Suggested by <b>{previewState.proposed.source}</b> — not loaded</span>
			</div>
			<code class="console-prev__propose-url">{previewState.proposed.url}</code>
			<div class="console-prev__propose-btns">
				<button type="button" class="primary" onclick={confirmProposedUrl}>Load this URL</button>
				<button type="button" class="ghost" onclick={dismissProposedUrl}>Dismiss</button>
			</div>
		</div>
	{/if}

	{#if selection.kind !== 'none'}
		<div class="console-prev__bar">
			{#if selection.kind === 'file'}
				<span class="console-prev__bar-icon"><Icon name="file" size={12} /></span>
				<span class="console-prev__bar-target" title={selection.path}>{selection.path}</span>
			{:else}
				<span class="console-prev__bar-icon console-prev__bar-icon--url"><Icon name="globe" size={12} /></span>
				<!-- The URL is always visible: it must be obvious what is framed. -->
				<span class="console-prev__bar-target" title={selection.url}>{selection.url}</span>
			{/if}
			<div class="console-prev__bar-btns">
				{#if selection.kind === 'file' && previewState.history.length > 0}
					<button type="button" title="Back" aria-label="Back" onclick={goBack}>
						<Icon name="caret" size={12} />
					</button>
				{/if}
				{#if selection.kind === 'file'}
					<button type="button" title="Reload" aria-label="Reload" onclick={() => fileQuery?.refresh()}>
						<Icon name="refresh" size={12} />
					</button>
				{:else if externalUrl}
					<a href={externalUrl} target="_blank" rel="noopener noreferrer" title="Open in a new tab" aria-label="Open in a new tab">
						<Icon name="external" size={12} />
					</a>
				{/if}
				<button type="button" title="Close preview" aria-label="Close preview" onclick={clearPreview}>
					<Icon name="x" size={12} />
				</button>
			</div>
		</div>
	{/if}

	<div class="console-prev__body">
		{#if selection.kind === 'none'}
			<div class="console-rail__empty">
				Nothing open. Type a file path or a URL above, or use the preview button on a tool call.
			</div>
		{:else if selection.kind === 'url'}
			{#if externalUrl}
				<iframe
					class="console-prev__frame"
					src={externalUrl}
					title="Preview of {externalUrl}"
					sandbox={iframeSandbox}
					referrerpolicy="no-referrer"
				></iframe>
			{:else}
				<div class="console-rail__empty">That URL can’t be previewed.</div>
			{/if}
		{:else if !conversationId}
			<div class="console-rail__empty">Open a chat to preview workspace files.</div>
		{:else if fileResult === undefined}
			<div class="console-rail__empty">Loading…</div>
		{:else if !fileResult.ok}
			<div class="console-prev__fail">
				<Icon name="alert" size={13} />
				<span>{fileResult.message}</span>
			</div>
		{:else if fileResult.payload.kind === 'directory'}
			{@const dir = fileResult.payload}
			<div class="console-prev__dir">
				{#each dir.entries as entry (entry.path)}
					<button type="button" class="console-prev__dir-row" onclick={() => openFilePreview(entry.path)}>
						<Icon name={entry.isDirectory ? 'folder' : 'file'} size={12} />
						<span class="n">{entry.name}{entry.isDirectory ? '/' : ''}</span>
						<span class="s">{entry.isDirectory ? '' : formatBytes(entry.size)}</span>
					</button>
				{/each}
				{#if dir.entries.length === 0}
					<div class="console-rail__empty">Empty directory.</div>
				{/if}
				{#if dir.truncated}
					<div class="console-prev__note">Listing truncated.</div>
				{/if}
			</div>
		{:else}
			{@const file = fileResult.payload}
			<div class="console-prev__meta">
				<span>{file.name}</span>
				<span>{formatBytes(file.size)}{file.language ? ` · ${file.language}` : ''}</span>
			</div>

			{#if file.kind === 'image' && file.rawUrl}
				<div class="console-prev__image"><img src={file.rawUrl} alt={file.name} /></div>
			{:else if file.kind === 'pdf' && file.rawUrl}
				<!--
					The browser's own PDF viewer gives paging, search and zoom for free.
					Served same-origin with `nosniff` and an explicit application/pdf type.
				-->
				<iframe class="console-prev__frame" src={file.rawUrl} title="PDF preview of {file.name}"></iframe>
			{:else if file.kind === 'binary'}
				<div class="console-prev__fail">
					<Icon name="alert" size={13} />
					<span>{file.note ?? 'Binary file — not rendered.'}</span>
				</div>
			{:else if file.kind === 'markdown'}
				{#if renderedHtml === null}
					<div class="console-rail__empty">Rendering…</div>
				{:else}
					<!-- Sanitized in `preview-render.ts`: raw HTML escaped, non-http(s) URLs dropped. -->
					<!-- eslint-disable-next-line svelte/no-at-html-tags -->
					<div class="console-prev__md">{@html renderedHtml}</div>
				{/if}
			{:else if file.kind === 'code' && renderedHtml !== null}
				<div class="console-prev__code">
					<div class="console-prev__gutter">
						{#each lineNumbers(file.content ?? '') as n (n)}<span>{n}</span>{/each}
					</div>
					<pre class="hljs"><code>{@html renderedHtml}</code></pre>
				</div>
			{:else}
				<div class="console-prev__code">
					<div class="console-prev__gutter">
						{#each lineNumbers(file.content ?? '') as n (n)}<span>{n}</span>{/each}
					</div>
					<pre><code>{file.content ?? ''}</code></pre>
				</div>
			{/if}

			{#if file.truncated}
				<div class="console-prev__note">Truncated — showing the first 512 KB.</div>
			{/if}
		{/if}
	</div>
</div>
