<script lang="ts">
	import type { MemoryDrawerDetail, MemoryDrawerAaak } from '$lib/memory/memory.remote';

	let {
		drawer,
		onBack,
		onCopy,
		onDelete,
	}: {
		drawer: MemoryDrawerDetail;
		onBack?: () => void;
		onCopy?: (content: string) => void;
		onDelete?: (id: string) => void;
	} = $props();

	const aaak = $derived(drawer.aaak as MemoryDrawerAaak | null);

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
					<button class="console-pill" onclick={copyContent}>
						{copied ? 'Copied!' : 'Copy'}
					</button>
					{#if onDelete}
						<button class="console-pill drawer-detail__delete" onclick={() => onDelete?.(drawer.id)}>
							Delete
						</button>
					{/if}
				</div>
			</div>
			<pre class="drawer-detail__content">{drawer.content}</pre>
		</section>

		<section class="drawer-detail__section">
			<div class="drawer-detail__sec-head">
				<span class="drawer-detail__sec-label">Metadata</span>
			</div>
			<dl class="drawer-detail__meta">
				<dt>Tokens</dt><dd>{drawer.tokenCount}</dd>
				<dt>Occurred</dt><dd>{formatFull(drawer.occurredAt)}</dd>
				<dt>Created</dt><dd>{formatFull(drawer.createdAt)}</dd>
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

		{#if drawer.linkedArtifact}
			<section class="drawer-detail__section">
				<div class="drawer-detail__sec-head">
					<span class="drawer-detail__sec-label">Linked artifact</span>
				</div>
				<div class="drawer-detail__artifact">{drawer.linkedArtifact.name}</div>
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

	.drawer-detail__artifact {
		padding: 6px 10px;
		background: var(--color-base-200);
		border: 1px solid var(--color-base-300);
		border-radius: 6px;
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
