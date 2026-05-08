<script lang="ts">
	import { searchMemoryQuery } from '$lib/memory/memory.remote';

	type SearchHit = {
		drawerId: string;
		wingId: string;
		closetId: string;
		content: string;
		wingName: string;
		closetTopic: string;
		occurredAt: string | Date;
		role: string;
		finalScore: number;
		semanticScore: number;
		keywordScore: number;
	};

	let {
		onSelectHit,
	}: {
		onSelectHit?: (hit: SearchHit) => void;
	} = $props();

	let q = $state('');
	let topK = $state(10);
	let useRerank = $state(false);
	let searching = $state(false);
	let results = $state<SearchHit[]>([]);
	let showOverlay = $state(false);

	async function run() {
		if (!q.trim()) return;
		searching = true;
		try {
			const hits = (await searchMemoryQuery({
				query: q.trim(),
				topK,
				useRerank,
			})) as unknown as SearchHit[];
			results = hits;
			showOverlay = true;
		} finally {
			searching = false;
		}
	}

	function close() {
		showOverlay = false;
	}

	function handleHit(hit: SearchHit) {
		onSelectHit?.(hit);
		showOverlay = false;
	}

	function formatTime(d: string | Date): string {
		const date = typeof d === 'string' ? new Date(d) : d;
		return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
	}
</script>

<div class="search-bar">
	<form
		class="search-bar__form"
		onsubmit={(e) => {
			e.preventDefault();
			void run();
		}}
	>
		<svg class="search-bar__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
		<input
			type="text"
			bind:value={q}
			placeholder="Search memories — try a phrase, name, or topic…"
			class="search-bar__input"
			onfocus={() => {
				if (results.length > 0) showOverlay = true;
			}}
		/>
		<label class="search-bar__opt">
			<span>top-k</span>
			<input type="number" min="1" max="20" bind:value={topK} class="search-bar__num" />
		</label>
		<label class="search-bar__opt">
			<input type="checkbox" bind:checked={useRerank} />
			<span>rerank</span>
		</label>
		<button type="submit" class="search-bar__submit" disabled={searching || !q.trim()}>
			{searching ? 'Searching…' : 'Search'}
		</button>
	</form>
</div>

{#if showOverlay && results.length > 0}
	<button class="search-overlay__scrim" onclick={close} aria-label="Close search results" type="button"></button>
	<div class="search-overlay">
		<header class="search-overlay__head">
			<span class="search-overlay__title">{results.length} matches for "{q}"</span>
			<button class="console-iconbtn" onclick={close} aria-label="Close">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-4 w-4"><path d="M18 6L6 18M6 6l12 12"/></svg>
			</button>
		</header>
		<ul class="search-overlay__list">
			{#each results as hit (hit.drawerId)}
				<li>
					<button class="search-overlay__hit" onclick={() => handleHit(hit)}>
						<div class="search-overlay__hit-head">
							<span class="search-overlay__hit-path">
								{hit.wingName} <span class="op-50">›</span> {hit.closetTopic}
							</span>
							<span class="search-overlay__hit-score">score {hit.finalScore.toFixed(3)}</span>
						</div>
						<div class="search-overlay__hit-content">{hit.content}</div>
						<div class="search-overlay__hit-foot">
							<span class="search-overlay__hit-role role-{hit.role}">{hit.role}</span>
							<span class="search-overlay__hit-time">{formatTime(hit.occurredAt)}</span>
							<span class="search-overlay__hit-sub">sem {hit.semanticScore.toFixed(2)} · kw {hit.keywordScore.toFixed(2)}</span>
						</div>
					</button>
				</li>
			{/each}
		</ul>
	</div>
{/if}

<style>
	.search-bar {
		flex: 0 0 auto;
		padding: 8px 12px;
		border-bottom: 1px solid var(--color-base-300);
		background: color-mix(in oklab, var(--color-base-content) 1.5%, var(--color-base-100));
	}

	.search-bar__form {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
		background: var(--color-base-100);
		border: 1px solid var(--color-base-300);
		border-radius: 8px;
		transition: border-color 120ms;
	}

	.search-bar__form:focus-within {
		border-color: var(--color-primary);
		box-shadow: 0 0 0 3px color-mix(in oklab, var(--color-primary) 15%, transparent);
	}

	.search-bar__icon {
		width: 16px;
		height: 16px;
		color: color-mix(in oklab, var(--color-base-content) 50%, transparent);
		flex: 0 0 auto;
	}

	.search-bar__input {
		flex: 1;
		min-width: 0;
		background: transparent;
		border: 0;
		outline: 0;
		font: inherit;
		font-family: Consolas, 'Cascadia Code', monospace;
		font-size: 13px;
		color: var(--color-base-content);
	}

	.search-bar__opt {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-family: Consolas, 'Cascadia Code', monospace;
		font-size: 11px;
		color: color-mix(in oklab, var(--color-base-content) 60%, transparent);
		flex: 0 0 auto;
	}

	.search-bar__num {
		width: 44px;
		padding: 2px 4px;
		background: var(--color-base-200);
		border: 1px solid var(--color-base-300);
		border-radius: 4px;
		font-family: inherit;
		font-size: 11px;
		color: var(--color-base-content);
		text-align: center;
	}

	.search-bar__submit {
		padding: 4px 12px;
		border-radius: 6px;
		background: var(--color-primary);
		color: var(--color-primary-content);
		border: 0;
		font: inherit;
		font-size: 11.5px;
		font-weight: 600;
		font-family: Consolas, 'Cascadia Code', monospace;
		cursor: pointer;
		flex: 0 0 auto;
	}

	.search-bar__submit:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.search-overlay__scrim {
		position: fixed;
		inset: 0;
		background: color-mix(in oklab, var(--color-base-100) 70%, transparent);
		backdrop-filter: blur(2px);
		z-index: 30;
		border: 0;
		padding: 0;
		cursor: default;
	}

	.search-overlay {
		position: fixed;
		top: calc(env(safe-area-inset-top, 0) + 80px);
		left: 50%;
		transform: translateX(-50%);
		width: min(720px, 92vw);
		max-height: min(70vh, 600px);
		background: var(--color-base-100);
		border: 1px solid var(--color-base-300);
		border-radius: 12px;
		box-shadow: 0 24px 48px color-mix(in oklab, var(--color-base-content) 25%, transparent);
		display: flex;
		flex-direction: column;
		z-index: 31;
		overflow: hidden;
		font-family: Consolas, 'Cascadia Code', monospace;
	}

	.search-overlay__head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 14px;
		border-bottom: 1px solid var(--color-base-300);
	}

	.search-overlay__title {
		font-size: 12px;
		color: color-mix(in oklab, var(--color-base-content) 70%, transparent);
	}

	.search-overlay__list {
		list-style: none;
		margin: 0;
		padding: 6px;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.search-overlay__hit {
		display: flex;
		flex-direction: column;
		gap: 4px;
		width: 100%;
		text-align: left;
		padding: 8px 10px;
		background: var(--color-base-100);
		border: 1px solid transparent;
		border-radius: 8px;
		font: inherit;
		cursor: pointer;
		color: var(--color-base-content);
	}

	.search-overlay__hit:hover {
		background: var(--color-base-200);
		border-color: var(--color-base-300);
	}

	.search-overlay__hit-head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		font-size: 10.5px;
	}

	.search-overlay__hit-path {
		color: color-mix(in oklab, var(--color-base-content) 70%, transparent);
		font-weight: 500;
	}

	.search-overlay__hit-score {
		font-size: 10px;
		color: color-mix(in oklab, var(--color-base-content) 50%, transparent);
		font-variant-numeric: tabular-nums;
	}

	.search-overlay__hit-content {
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
		font-size: 12px;
		line-height: 1.45;
		white-space: pre-wrap;
		color: color-mix(in oklab, var(--color-base-content) 90%, transparent);
	}

	.search-overlay__hit-foot {
		display: flex;
		gap: 8px;
		font-size: 10px;
	}

	.search-overlay__hit-role {
		text-transform: uppercase;
		letter-spacing: 0.08em;
		font-weight: 700;
	}

	.search-overlay__hit-role.role-user { color: var(--color-primary); }
	.search-overlay__hit-role.role-assistant { color: var(--color-secondary); }
	.search-overlay__hit-role.role-system { color: var(--color-accent); }
	.search-overlay__hit-role.role-note { color: color-mix(in oklab, var(--color-base-content) 60%, transparent); }

	.search-overlay__hit-time {
		color: color-mix(in oklab, var(--color-base-content) 55%, transparent);
	}

	.search-overlay__hit-sub {
		margin-left: auto;
		color: color-mix(in oklab, var(--color-base-content) 45%, transparent);
		font-variant-numeric: tabular-nums;
	}

	.op-50 { opacity: 0.5; padding: 0 4px; }
</style>
