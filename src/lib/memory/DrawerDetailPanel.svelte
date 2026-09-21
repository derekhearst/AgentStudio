<script lang="ts">
	import {
		editMemoryDrawerCommand,
		setMemoryDrawerFlagsCommand,
		type MemoryDrawerDetail,
		type MemoryDrawerAaak,
	} from '$lib/memory/memory.remote';

	let {
		drawer,
		onBack,
		onCopy,
		onDelete,
		onChanged,
	}: {
		drawer: MemoryDrawerDetail;
		onBack?: () => void;
		onCopy?: (content: string) => void;
		onDelete?: (id: string) => void;
		/** Called after an edit or flag change lands, so the parent can refresh counts. */
		onChanged?: () => void;
	} = $props();

	const aaak = $derived(drawer.aaak as MemoryDrawerAaak | null);

	// --- edit state -------------------------------------------------------------
	let editing = $state(false);
	let draft = $state('');
	let saving = $state(false);
	let saveError = $state<string | null>(null);
	let embedWarning = $state<string | null>(null);

	// --- flag state (optimistic, reconciled from the command response) ----------
	let pinned = $state(false);
	let neverRecall = $state(false);
	let flagBusy = $state(false);

	$effect(() => {
		// Reset local state whenever a different drawer is shown.
		const id = drawer.id;
		void id;
		editing = false;
		saveError = null;
		embedWarning = null;
		pinned = drawer.pinned;
		neverRecall = drawer.neverRecall;
	});

	function startEdit() {
		draft = drawer.content;
		saveError = null;
		editing = true;
	}

	function cancelEdit() {
		editing = false;
		draft = '';
		saveError = null;
	}

	async function saveEdit() {
		if (saving) return;
		const next = draft.trim();
		if (next.length === 0) {
			saveError = 'Content cannot be empty. Delete the drawer instead.';
			return;
		}
		if (next === drawer.content) {
			editing = false;
			return;
		}
		saving = true;
		saveError = null;
		embedWarning = null;
		try {
			const result = await editMemoryDrawerCommand({ id: drawer.id, content: next });
			if (!result.ok) {
				saveError =
					result.reason === 'too_long'
						? 'That is too long for one drawer.'
						: result.reason === 'empty'
							? 'Content cannot be empty.'
							: 'Drawer not found.';
				return;
			}
			if (!result.reEmbedded) {
				embedWarning =
					'Saved, but re-embedding failed, so the vector was cleared rather than left stale. This drawer is out of semantic recall until the next Reorganize backfill.';
			}
			editing = false;
			onChanged?.();
		} catch (err) {
			saveError = err instanceof Error ? err.message : 'Save failed.';
		} finally {
			saving = false;
		}
	}

	async function toggleFlag(flag: 'pinned' | 'neverRecall') {
		if (flagBusy) return;
		flagBusy = true;
		const next = flag === 'pinned' ? !pinned : !neverRecall;
		try {
			const result = await setMemoryDrawerFlagsCommand({
				id: drawer.id,
				...(flag === 'pinned' ? { pinned: next } : { neverRecall: next }),
			});
			if (result.ok) {
				pinned = result.pinned;
				neverRecall = result.neverRecall;
				onChanged?.();
			}
		} finally {
			flagBusy = false;
		}
	}

	function scorePct(value: number): number {
		return Math.max(0, Math.min(100, Math.round(value * 100)));
	}

	const tagGroups = $derived.by(() => {
		const tags = aaak?.tags ?? {};
		return [
			{ label: 'People', items: tags.p ?? [], color: 'is-people' },
			{ label: 'Locations', items: tags.l ?? [], color: 'is-locations' },
			{ label: 'Events', items: tags.e ?? [], color: 'is-events' },
			{ label: 'Items', items: tags.i ?? [], color: 'is-items' },
			{ label: 'Topics', items: tags.t ?? [], color: 'is-topics' },
		].filter((g) => g.items.length > 0);
	});

	let copied = $state(false);

	async function copyContent() {
		try {
			await navigator.clipboard.writeText(drawer.content);
			copied = true;
			onCopy?.(drawer.content);
			setTimeout(() => (copied = false), 1500);
		} catch {
			copied = false;
		}
	}

	function formatFull(d: string | Date): string {
		const date = typeof d === 'string' ? new Date(d) : d;
		return date.toLocaleString();
	}
</script>

<div class="drawer-detail">
	<header class="drawer-detail__head">
		{#if onBack}
			<button class="console-iconbtn" onclick={onBack} aria-label="Back to wing" title="Back">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-4 w-4"><path d="M15 19l-7-7 7-7"/></svg>
			</button>
		{/if}
		<div class="drawer-detail__title">
			<span class="drawer-detail__role role-{drawer.role}">{drawer.role}</span>
			<span class="drawer-detail__path">
				{drawer.wingName} <span class="op-50">›</span> {drawer.roomLabel} <span class="op-50">›</span> {drawer.closetTopic}
			</span>
		</div>
	</header>

	<div class="drawer-detail__body">
		<section class="drawer-detail__section">
			<div class="drawer-detail__sec-head">
				<span class="drawer-detail__sec-label">Content</span>
				<div class="drawer-detail__sec-actions">
					{#if editing}
						<button class="console-pill" onclick={saveEdit} disabled={saving}>
							{saving ? 'Saving…' : 'Save'}
						</button>
						<button class="console-pill" onclick={cancelEdit} disabled={saving}>Cancel</button>
					{:else}
						<button class="console-pill" onclick={startEdit} title="Rewrite this memory and re-embed it">
							Edit
						</button>
						<button class="console-pill" onclick={copyContent}>
							{copied ? 'Copied!' : 'Copy'}
						</button>
						{#if onDelete}
							<button class="console-pill drawer-detail__delete" onclick={() => onDelete?.(drawer.id)}>
								Delete
							</button>
						{/if}
					{/if}
				</div>
			</div>

			{#if editing}
				<textarea
					class="drawer-detail__editor"
					bind:value={draft}
					rows="10"
					disabled={saving}
					aria-label="Drawer content"
				></textarea>
				<p class="drawer-detail__hint">
					Saving re-embeds this drawer so the vector matches the new wording. If embedding is unavailable the
					vector is cleared instead of left stale.
				</p>
			{:else}
				<pre class="drawer-detail__content">{drawer.content}</pre>
			{/if}

			{#if saveError}
				<p class="drawer-detail__error">{saveError}</p>
			{/if}
			{#if embedWarning}
				<p class="drawer-detail__warn">{embedWarning}</p>
			{/if}
		</section>

		<section class="drawer-detail__section">
			<div class="drawer-detail__sec-head">
				<span class="drawer-detail__sec-label">Recall control</span>
			</div>
			<div class="drawer-detail__flags">
				<button
					class="drawer-detail__flag"
					class:is-on={pinned}
					disabled={flagBusy}
					onclick={() => toggleFlag('pinned')}
					title="Pinned drawers are always considered during recall and get a score boost"
				>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-3 w-3"><path d="M12 17v5M5 9l7-7 7 7-2 2v4l2 3H3l2-3v-4z"/></svg>
					{pinned ? 'Pinned' : 'Pin'}
				</button>
				<button
					class="drawer-detail__flag is-danger"
					class:is-on={neverRecall}
					disabled={flagBusy}
					onclick={() => toggleFlag('neverRecall')}
					title="Never-recall drawers stay browsable here but are excluded from every recall"
				>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-3 w-3"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>
					{neverRecall ? 'Never recalled' : 'Never recall'}
				</button>
			</div>
			{#if neverRecall}
				<p class="drawer-detail__hint">Excluded from recall. It stays in the palace so you can review or delete it.</p>
			{/if}
		</section>

		<section class="drawer-detail__section">
			<div class="drawer-detail__sec-head">
				<span class="drawer-detail__sec-label">Why was this recalled?</span>
				<span class="drawer-detail__sec-note">{drawer.recallCount} recall{drawer.recallCount === 1 ? '' : 's'}</span>
			</div>
			{#if drawer.recallEvents.length === 0}
				<p class="drawer-detail__hint">
					This drawer hasn't been recalled yet. Once it appears in a memory context block or a palace search, the
					semantic / keyword / temporal scores that put it there show up here.
				</p>
			{:else}
				<ul class="drawer-detail__recalls">
					{#each drawer.recallEvents as event (event.id)}
						<li class="drawer-detail__recall">
							<div class="drawer-detail__recall-head">
								<span class="drawer-detail__recall-source src-{event.source}">{event.source}</span>
								<span class="drawer-detail__recall-query" title={event.query}>“{event.query}”</span>
								<span class="drawer-detail__recall-rank">#{event.rank}</span>
							</div>
							<div class="drawer-detail__recall-bars">
								{#each [{ label: 'sem', value: event.semanticScore, cls: 'is-sem' }, { label: 'kw', value: event.keywordScore, cls: 'is-kw' }, { label: 'tmp', value: event.temporalScore, cls: 'is-tmp' }] as part (part.label)}
									<div class="drawer-detail__bar-row">
										<span class="drawer-detail__bar-label">{part.label}</span>
										<span class="drawer-detail__bar-track">
											<span class="drawer-detail__bar-fill {part.cls}" style:width="{scorePct(part.value)}%"></span>
										</span>
										<span class="drawer-detail__bar-value">{part.value.toFixed(3)}</span>
									</div>
								{/each}
							</div>
							<div class="drawer-detail__recall-foot">
								<span>final {event.finalScore.toFixed(3)}</span>
								{#if event.pinnedBoost > 0}
									<span class="drawer-detail__recall-pin">+{event.pinnedBoost.toFixed(2)} pinned</span>
								{/if}
								{#if event.weights}
									<span class="op-50">
										weights {event.weights.semantic}/{event.weights.keyword}/{event.weights.temporal}
									</span>
								{/if}
								<span class="drawer-detail__recall-time">{formatFull(event.createdAt)}</span>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<section class="drawer-detail__section">
			<div class="drawer-detail__sec-head">
				<span class="drawer-detail__sec-label">Metadata</span>
			</div>
			<dl class="drawer-detail__meta">
				<dt>Tokens</dt><dd>{drawer.tokenCount}</dd>
				<dt>Occurred</dt><dd>{formatFull(drawer.occurredAt)}</dd>
				<dt>Created</dt><dd>{formatFull(drawer.createdAt)}</dd>
				{#if drawer.editedAt}
					<dt>Edited</dt><dd>{formatFull(drawer.editedAt)}</dd>
				{/if}
				<dt>Embedding</dt>
				<dd class:is-warn={!drawer.hasEmbedding}>
					{drawer.hasEmbedding ? 'present' : 'missing — not in semantic recall'}
				</dd>
				{#if drawer.conversationTitle}
					<dt>Conversation</dt>
					<dd>
						<a class="link" href={`/chat/${drawer.conversationId}`}>{drawer.conversationTitle}</a>
					</dd>
				{/if}
			</dl>
		</section>

		{#if tagGroups.length > 0}
			<section class="drawer-detail__section">
				<div class="drawer-detail__sec-head">
					<span class="drawer-detail__sec-label">AAAK tags</span>
				</div>
				<div class="drawer-detail__tags">
					{#each tagGroups as group (group.label)}
						<div class="drawer-detail__tag-group {group.color}">
							<span class="drawer-detail__tag-label">{group.label}</span>
							<div class="drawer-detail__tag-items">
								{#each group.items as item (item)}
									<span class="drawer-detail__tag">{item}</span>
								{/each}
							</div>
						</div>
					{/each}
				</div>
				{#if aaak?.pointer}
					<div class="drawer-detail__pointer">pointer: {aaak.pointer}</div>
				{/if}
			</section>
		{/if}

		{#if drawer.sourceMessage}
			<section class="drawer-detail__section">
				<div class="drawer-detail__sec-head">
					<span class="drawer-detail__sec-label">Source message</span>
					{#if drawer.conversationId}
						<a class="console-pill" href={`/chat/${drawer.conversationId}`}>Open chat →</a>
					{/if}
				</div>
				<div class="drawer-detail__source">
					<span class="drawer-detail__source-role">{drawer.sourceMessage.role}</span>
					<p>{drawer.sourceMessage.content.slice(0, 400)}{drawer.sourceMessage.content.length > 400 ? '…' : ''}</p>
				</div>
			</section>
		{/if}

		{#if drawer.kgRelations.length > 0}
			<section class="drawer-detail__section">
				<div class="drawer-detail__sec-head">
					<span class="drawer-detail__sec-label">Knowledge graph</span>
				</div>
				<ul class="drawer-detail__kg">
					{#each drawer.kgRelations as rel (rel.relationId)}
						<li>
							<span class="kg-from">{rel.fromName}</span>
							<span class="kg-rel">— {rel.relation} —</span>
							<span class="kg-to">{rel.toName}</span>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	</div>
</div>

<style>
	.drawer-detail {
		display: flex;
		flex-direction: column;
		gap: 12px;
		font-family: Consolas, 'Cascadia Code', monospace;
		font-size: 12px;
	}

	.drawer-detail__head {
		display: flex;
		align-items: center;
		gap: 8px;
		padding-bottom: 8px;
		border-bottom: 1px solid var(--color-base-300);
	}

	.drawer-detail__title {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1;
	}

	.drawer-detail__role {
		font-size: 9.5px;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		font-weight: 700;
	}

	.drawer-detail__role.role-user { color: var(--color-primary); }
	.drawer-detail__role.role-assistant { color: var(--color-secondary); }
	.drawer-detail__role.role-system { color: var(--color-accent); }
	.drawer-detail__role.role-note { color: color-mix(in oklab, var(--color-base-content) 60%, transparent); }

	.drawer-detail__path {
		font-size: 11px;
		color: var(--color-base-content);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.op-50 { opacity: 0.5; padding: 0 4px; }

	.drawer-detail__body {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.drawer-detail__section {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.drawer-detail__sec-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.drawer-detail__sec-label {
		font-size: 9.5px;
		text-transform: uppercase;
		letter-spacing: 0.16em;
		color: color-mix(in oklab, var(--color-base-content) 50%, transparent);
		font-weight: 600;
	}

	.drawer-detail__sec-actions {
		display: flex;
		gap: 4px;
	}

	.drawer-detail__delete {
		color: var(--color-error);
		border-color: color-mix(in oklab, var(--color-error) 40%, var(--color-base-300));
	}

	.drawer-detail__delete:hover {
		background: color-mix(in oklab, var(--color-error) 15%, transparent);
		color: var(--color-error);
	}

	.drawer-detail__content {
		margin: 0;
		padding: 10px 12px;
		background: var(--color-base-200);
		border: 1px solid var(--color-base-300);
		border-radius: 6px;
		font-family: Consolas, 'Cascadia Code', monospace;
		font-size: 12px;
		line-height: 1.55;
		white-space: pre-wrap;
		word-break: break-word;
		max-height: 360px;
		overflow-y: auto;
	}

	.drawer-detail__sec-note {
		font-size: 10px;
		color: color-mix(in oklab, var(--color-base-content) 45%, transparent);
	}

	.drawer-detail__editor {
		width: 100%;
		padding: 10px 12px;
		background: var(--color-base-200);
		border: 1px solid color-mix(in oklab, var(--color-primary) 40%, var(--color-base-300));
		border-radius: 6px;
		font-family: Consolas, 'Cascadia Code', monospace;
		font-size: 12px;
		line-height: 1.55;
		color: var(--color-base-content);
		resize: vertical;
		min-height: 120px;
	}

	.drawer-detail__hint {
		margin: 0;
		font-size: 10.5px;
		line-height: 1.45;
		color: color-mix(in oklab, var(--color-base-content) 50%, transparent);
	}

	.drawer-detail__error {
		margin: 0;
		font-size: 11px;
		color: var(--color-error);
	}

	.drawer-detail__warn {
		margin: 0;
		font-size: 11px;
		line-height: 1.45;
		color: var(--color-warning);
	}

	.drawer-detail__flags {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}

	.drawer-detail__flag {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 3px 9px;
		border-radius: 999px;
		border: 1px solid var(--color-base-300);
		background: var(--color-base-100);
		font-family: inherit;
		font-size: 11px;
		color: color-mix(in oklab, var(--color-base-content) 70%, transparent);
		cursor: pointer;
	}

	.drawer-detail__flag:hover:not(:disabled) {
		border-color: color-mix(in oklab, var(--color-primary) 40%, var(--color-base-300));
	}

	.drawer-detail__flag:disabled {
		opacity: 0.6;
		cursor: default;
	}

	.drawer-detail__flag.is-on {
		border-color: var(--color-primary);
		background: color-mix(in oklab, var(--color-primary) 14%, transparent);
		color: var(--color-primary);
	}

	.drawer-detail__flag.is-danger.is-on {
		border-color: var(--color-error);
		background: color-mix(in oklab, var(--color-error) 14%, transparent);
		color: var(--color-error);
	}

	.drawer-detail__recalls {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.drawer-detail__recall {
		padding: 8px 10px;
		border: 1px solid var(--color-base-300);
		border-radius: 6px;
		background: color-mix(in oklab, var(--color-base-content) 2%, var(--color-base-100));
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.drawer-detail__recall-head {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}

	.drawer-detail__recall-source {
		flex: 0 0 auto;
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		font-weight: 700;
		padding: 1px 5px;
		border-radius: 3px;
		background: var(--color-base-200);
		color: color-mix(in oklab, var(--color-base-content) 60%, transparent);
	}

	.drawer-detail__recall-source.src-chat { color: var(--color-primary); }
	.drawer-detail__recall-source.src-search { color: var(--color-info); }
	.drawer-detail__recall-source.src-agent { color: var(--color-secondary); }

	.drawer-detail__recall-query {
		flex: 1;
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		font-size: 11px;
		color: var(--color-base-content);
	}

	.drawer-detail__recall-rank {
		flex: 0 0 auto;
		font-size: 10px;
		color: color-mix(in oklab, var(--color-base-content) 45%, transparent);
	}

	.drawer-detail__recall-bars {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.drawer-detail__bar-row {
		display: grid;
		grid-template-columns: 26px 1fr 44px;
		align-items: center;
		gap: 6px;
	}

	.drawer-detail__bar-label {
		font-size: 9.5px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: color-mix(in oklab, var(--color-base-content) 45%, transparent);
	}

	.drawer-detail__bar-track {
		display: block;
		height: 5px;
		border-radius: 999px;
		background: var(--color-base-200);
		overflow: hidden;
	}

	.drawer-detail__bar-fill {
		display: block;
		height: 100%;
		border-radius: 999px;
	}

	.drawer-detail__bar-fill.is-sem { background: var(--color-primary); }
	.drawer-detail__bar-fill.is-kw { background: var(--color-secondary); }
	.drawer-detail__bar-fill.is-tmp { background: var(--color-accent); }

	.drawer-detail__bar-value {
		font-size: 10px;
		text-align: right;
		color: color-mix(in oklab, var(--color-base-content) 60%, transparent);
	}

	.drawer-detail__recall-foot {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		font-size: 10px;
		color: color-mix(in oklab, var(--color-base-content) 55%, transparent);
	}

	.drawer-detail__recall-pin {
		color: var(--color-primary);
	}

	.drawer-detail__recall-time {
		margin-left: auto;
	}

	.drawer-detail__meta dd.is-warn {
		color: var(--color-warning);
	}

	.drawer-detail__meta {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 4px 12px;
		margin: 0;
	}

	.drawer-detail__meta dt {
		color: color-mix(in oklab, var(--color-base-content) 50%, transparent);
		font-size: 11px;
	}

	.drawer-detail__meta dd {
		margin: 0;
		font-size: 11px;
		color: var(--color-base-content);
	}

	.drawer-detail__tags {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.drawer-detail__tag-group {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.drawer-detail__tag-label {
		font-size: 9.5px;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: color-mix(in oklab, var(--color-base-content) 50%, transparent);
	}

	.drawer-detail__tag-items {
		display: flex;
		gap: 4px;
		flex-wrap: wrap;
	}

	.drawer-detail__tag {
		display: inline-block;
		padding: 1px 6px;
		border-radius: 3px;
		background: var(--color-base-200);
		border: 1px solid var(--color-base-300);
		font-size: 11px;
		color: var(--color-base-content);
	}

	.drawer-detail__tag-group.is-people .drawer-detail__tag { border-left: 2px solid var(--color-primary); }
	.drawer-detail__tag-group.is-locations .drawer-detail__tag { border-left: 2px solid var(--color-secondary); }
	.drawer-detail__tag-group.is-events .drawer-detail__tag { border-left: 2px solid var(--color-accent); }
	.drawer-detail__tag-group.is-items .drawer-detail__tag { border-left: 2px solid var(--color-info); }
	.drawer-detail__tag-group.is-topics .drawer-detail__tag { border-left: 2px solid var(--color-warning); }

	.drawer-detail__pointer {
		font-size: 10px;
		color: color-mix(in oklab, var(--color-base-content) 45%, transparent);
		margin-top: 2px;
	}

	.drawer-detail__source {
		padding: 8px 10px;
		background: color-mix(in oklab, var(--color-base-content) 2%, var(--color-base-100));
		border: 1px solid var(--color-base-300);
		border-radius: 6px;
	}

	.drawer-detail__source-role {
		display: inline-block;
		font-size: 9.5px;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: color-mix(in oklab, var(--color-base-content) 50%, transparent);
		margin-bottom: 4px;
	}

	.drawer-detail__source p {
		margin: 0;
		font-size: 11.5px;
		line-height: 1.5;
		white-space: pre-wrap;
	}

	.drawer-detail__kg {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.drawer-detail__kg li {
		font-size: 11px;
	}

	.kg-from, .kg-to { color: var(--color-base-content); font-weight: 500; }
	.kg-rel { color: color-mix(in oklab, var(--color-base-content) 50%, transparent); padding: 0 4px; }

	.link {
		color: var(--color-primary);
		text-decoration: none;
	}

	.link:hover {
		text-decoration: underline;
	}
</style>
