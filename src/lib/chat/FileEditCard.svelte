<script lang="ts">
	import Icon from '$lib/chat-console/Icon.svelte';
	import { openFilePreview, revealRail } from '$lib/chat-console/preview-state.svelte';
	import type { FileEditDetails } from '$lib/engine/tool-result-details';

	/**
	 * #16 — renders an `Edit` / `MultiEdit` / `Write` as the diff it actually is.
	 *
	 * The hunks come from the SDK's own `structuredPatch` (see
	 * `$lib/engine/tool-result-details`), so nothing here re-reads the file or recomputes a
	 * diff: by the time this renders, the patch has been computed, capped and persisted.
	 * That also means this component must handle a diff that is legitimately absent — a
	 * write that changed nothing, or one the SDK could not diff — rather than assuming
	 * hunks exist.
	 */

	let {
		details,
		success = true,
		expanded
	}: {
		details: FileEditDetails;
		success?: boolean;
		expanded?: boolean;
	} = $props();

	const lineCount = $derived(details.hunks.reduce((n, hunk) => n + hunk.lines.length, 0));

	/** Open a small edit, leave a large one folded — the header already says what changed. */
	const defaultExpanded = $derived(lineCount > 0 && lineCount <= 40);
	const isOpen = $derived(expanded ?? defaultExpanded);

	const separator = $derived(Math.max(details.path.lastIndexOf('/'), details.path.lastIndexOf('\\')));
	const dirName = $derived(separator > 0 ? details.path.slice(0, separator + 1) : '');
	const baseName = $derived(separator > 0 ? details.path.slice(separator + 1) : details.path);

	const accentClass = $derived(success ? 'console-tool ok' : 'console-tool err');

	const verb = $derived(
		details.changeType === 'create' ? 'Created' : details.tool === 'Write' ? 'Rewrote' : 'Edited'
	);

	// A created file's diff is its contents, so it has no lines only when it is empty — or
	// when it was saved before new files were diffed, as "no change". It is never "no change".
	const emptyReason = $derived(
		details.changeType === 'create'
			? details.unavailable === 'none' && details.additions === 0
				? 'An empty new file.'
				: 'A new file — open it to see its contents.'
			: details.unavailable === 'no_change'
				? 'No changes — the file already matched what was written.'
				: details.unavailable === 'diff_missing'
					? 'The diff is unavailable for this edit (the previous contents were too large to diff).'
					: ''
	);

	type NumberedLine = { text: string; cls: string; no: number | null };

	/**
	 * Number each line against the *new* file, the way a unified diff reads.
	 *
	 * A removed line has no line number in the new file, so it gets none — numbering it
	 * sequentially would make every line below a deletion appear one off, which is exactly
	 * the sort of quiet wrongness a diff view must not have.
	 */
	const numberedHunks = $derived(
		details.hunks.map((hunk) => {
			let no = hunk.newStart;
			const rows: NumberedLine[] = [];
			for (const text of hunk.lines) {
				if (text.startsWith('-')) rows.push({ text, cls: 'is-del', no: null });
				else if (text.startsWith('+')) rows.push({ text, cls: 'is-add', no: no++ });
				else rows.push({ text, cls: '', no: no++ });
			}
			return rows;
		})
	);

	function showFile() {
		openFilePreview(details.path);
		revealRail();
	}
</script>

<details class={`tool-call-card console-diff ${accentClass}`} open={isOpen}>
	<summary class="select-none transition-colors hover:bg-base-200/50">
		<div class="flex min-w-0 flex-1 items-center gap-2">
			<Icon name="file" size={13} />
			<span class="console-diff__path" title={details.path}>
				{#if dirName}<span class="console-diff__dir">{dirName}</span>{/if}<span>{baseName}</span>
			</span>
			<span class="console-diff__verb">{verb}</span>
		</div>

		<div class="ml-2 flex shrink-0 items-center gap-2">
			{#if details.additions > 0}
				<span class="console-diff__stat is-add">+{details.additions}</span>
			{/if}
			{#if details.deletions > 0}
				<span class="console-diff__stat is-del">−{details.deletions}</span>
			{/if}
			{#if !success}
				<span class="text-[11px] text-error/70">failed</span>
			{/if}
		</div>
	</summary>

	<div class="collapse-content">
		<div class="flex flex-wrap items-center">
			<button
				type="button"
				class="console-prev-chip"
				title={`Preview ${details.path}`}
				onclick={showFile}
			>
				<Icon name="file" size={10} />
				<span>Open file</span>
			</button>
		</div>

		{#if details.hunks.length > 0}
			<div class="console-diff__body">
				{#each numberedHunks as rows, hunkIdx (hunkIdx)}
					{#if hunkIdx > 0}
						<div class="console-diff__gap">⋯</div>
					{/if}
					{#each rows as row, lineIdx (`${hunkIdx}-${lineIdx}`)}
						<div class={`console-diff__line ${row.cls}`}>
							<span class="console-diff__no">{row.no ?? ''}</span>
							<span class="console-diff__text">{row.text}</span>
						</div>
					{/each}
				{/each}
			</div>
			{#if details.truncated}
				<p class="console-diff__note">
					Diff truncated — open the file to see the rest of the change.
				</p>
			{/if}
		{:else if emptyReason}
			<p class="console-diff__note">{emptyReason}</p>
		{/if}
	</div>
</details>
