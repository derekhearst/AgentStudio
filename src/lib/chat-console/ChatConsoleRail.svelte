<script lang="ts">
	import Icon from './Icon.svelte';
	import { consoleState } from './console-state.svelte';
	import { listResearchForConversationQuery } from '$lib/research/research.remote';

	let activeTab = $state<'Artifacts' | 'Files' | 'Activity'>('Artifacts');

	const conversationId = $derived(consoleState.conversationId);

	// Research runs for the current conversation, polled lazily through the remote query.
	const researchQuery = $derived.by(() => {
		if (!conversationId) return null;
		try {
			return listResearchForConversationQuery({ conversationId, limit: 5 });
		} catch {
			return null;
		}
	});

	const research = $derived.by(() => {
		const q = researchQuery;
		if (!q) return [];
		const value = q.current;
		return Array.isArray(value) ? value : [];
	});

	// Activity rows derived from streaming blocks (tool calls only).
	const activityRows = $derived.by(() => {
		return consoleState.streamingBlocks
			.filter((b) => b.kind === 'tool')
			.map((b) => {
				if (b.kind !== 'tool') return null;
				const status =
					b.status === 'pending' || b.status === 'approved'
						? 'warn'
						: b.status === 'executing'
						? 'run'
						: b.status === 'failed' || b.status === 'denied'
						? 'err'
						: 'ok';
				return {
					id: b.id,
					name: b.name,
					status,
					executionMs: b.executionMs ?? null,
				};
			})
			.filter((r): r is NonNullable<typeof r> => r !== null);
	});

	const turnAge = $derived.by(() => {
		const start = consoleState.runStatus.startedAt;
		if (!start) return null;
		const sec = Math.max(0, Math.floor((Date.now() - start) / 1000));
		const mm = Math.floor(sec / 60);
		const ss = String(sec % 60).padStart(2, '0');
		return `${mm}:${ss}`;
	});

	const ctxPct = $derived.by(() => {
		const lc = consoleState.liveContext;
		if (!lc || !lc.tokenEstimate || !lc.contextWindow || lc.contextWindow <= 0) return 0;
		return Math.max(0, Math.min(100, (lc.tokenEstimate / lc.contextWindow) * 100));
	});

	const ctxLabel = $derived.by(() => {
		const lc = consoleState.liveContext;
		if (!lc || !lc.tokenEstimate) return '—';
		const used = (lc.tokenEstimate / 1000).toFixed(1);
		const total = lc.contextWindow ? `${(lc.contextWindow / 1000).toFixed(0)}K` : '?';
		return `${used}K / ${total}`;
	});

	function formatTokens(n: number) {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
		if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
		return String(n);
	}

	function formatCost(n: number) {
		if (n >= 1) return `$${n.toFixed(2)}`;
		return `$${n.toFixed(4)}`;
	}

	function progressPct(r: { phase?: string | null; status?: string | null }) {
		switch (r.status) {
			case 'planning':
				return 10;
			case 'searching':
				return 35;
			case 'fetching':
				return 55;
			case 'reflecting':
				return 75;
			case 'synthesizing':
				return 90;
			case 'complete':
				return 100;
			default:
				return 0;
		}
	}

	function isRunningStatus(s: string | null | undefined) {
		return s === 'planning' || s === 'searching' || s === 'fetching' || s === 'reflecting' || s === 'synthesizing';
	}
</script>

<aside class="console-rail">
	<div class="console-rail__tabs">
		{#each ['Artifacts', 'Files', 'Activity'] as tab (tab)}
			<button
				type="button"
				class="console-rail__tab {activeTab === tab ? 'active' : ''}"
				onclick={() => (activeTab = tab as typeof activeTab)}
			>
				{tab}
				{#if tab === 'Artifacts' && research.length > 0}
					<span class="ct">{research.length}</span>
				{:else if tab === 'Activity' && activityRows.length > 0}
					<span class="ct">{activityRows.length}</span>
				{/if}
			</button>
		{/each}
	</div>

	<div class="console-rail__body">
		{#if activeTab === 'Artifacts'}
			{#if research.length === 0}
				<div class="console-rail__empty">No artifacts for this chat yet.</div>
			{:else}
				{#each research as r (r.id)}
					{@const running = isRunningStatus(r.status)}
					{@const pct = progressPct(r)}
					<div class="console-art {running ? 'is-progress' : ''}">
						<div class="console-art__head">
							<span class="console-art__type">RESEARCH</span>
							{#if running}
								<span class="console-art__status run">
									<span class="pulse-dot" style="background:currentColor;width:5px;height:5px;border-radius:999px;display:inline-block;animation:console-pulse 1.6s ease-in-out infinite"></span>
									{r.status}
								</span>
							{:else}
								<span class="console-art__status">
									<Icon name="check" size={11} /> {r.status}
								</span>
							{/if}
						</div>
						<div class="console-art__title">{r.query}</div>
						{#if running}
							<div class="console-art__progress">
								<div class="console-art__bar"><div style="width:{pct}%;"></div></div>
								<span class="console-art__pct">{pct}%</span>
							</div>
						{/if}
					</div>
				{/each}
			{/if}
		{:else if activeTab === 'Files'}
			<div class="console-rail__sec">
				<div class="lbl">
					<span>Branch</span>
					<span class="meta">main · clean</span>
				</div>
			</div>
			<div class="console-files__branch">
				<div class="row">
					<span class="b"><Icon name="branch" size={13} /> main</span>
				</div>
				<div class="sub">no source-control plumbing yet</div>
				<div class="console-files__btns">
					<button type="button" class="ghost" disabled><Icon name="branch" size={11} /> Switch</button>
					<button type="button" class="ghost" disabled>Pull</button>
				</div>
			</div>
			<div class="console-rail__empty">
				Source control integration coming soon — file changes from agent edits will appear here.
			</div>
		{:else if activeTab === 'Activity'}
			<div class="console-rail__sec">
				<div class="lbl">
					<span>Live · this turn</span>
					{#if turnAge}<span class="meta" style="color:var(--color-primary);">{turnAge}</span>{/if}
				</div>
			</div>
			{#if activityRows.length === 0}
				<div class="console-rail__empty">No activity yet on this turn.</div>
			{:else}
				{#each activityRows as a (a.id)}
					<div class="console-act {a.status}">
						<div class="console-act__icon">
							{#if a.status === 'run'}
								<span class="spin"></span>
							{:else if a.status === 'warn'}
								<Icon name="alert" size={12} />
							{:else if a.status === 'err'}
								<Icon name="x" size={12} />
							{:else}
								<Icon name="check" size={12} />
							{/if}
						</div>
						<div class="console-act__title">{a.name}</div>
						<div class="console-act__t">{a.executionMs ? `${a.executionMs}ms` : ''}</div>
					</div>
				{/each}
			{/if}

			{#if consoleState.persistedToolCalls.length > 0}
				<div class="console-rail__sec" style="margin-top:10px;">
					<div class="lbl"><span>Earlier</span></div>
				</div>
				{#each consoleState.persistedToolCalls.slice(0, 8) as call, i (i)}
					<div class="console-act {call.success === false ? 'err' : 'ok'}">
						<div class="console-act__icon">
							{#if call.success === false}
								<Icon name="x" size={12} />
							{:else}
								<Icon name="check" size={12} />
							{/if}
						</div>
						<div class="console-act__title">{call.name}</div>
						<div class="console-act__t">{call.ageMin}m</div>
					</div>
				{/each}
			{/if}
		{/if}
	</div>

	<div class="console-stats">
		<div class="console-stats__ctx">
			<div class="console-stats__ctx-row">
				<span class="l">Context</span>
				<span class="v">{Math.round(ctxPct)}% · <span style="color:color-mix(in oklab,var(--color-base-content) 50%,transparent);">{ctxLabel}</span></span>
			</div>
			<div class="console-meter">
				<div class="fill" style="width:{ctxPct}%"></div>
				<div class="reserved" style="left:{ctxPct}%;width:{Math.max(0, Math.min(30, 100 - ctxPct))}%"></div>
			</div>
		</div>
		<div class="console-stats__row">
			<div>
				<span class="l">Tokens</span>
				<span class="v lime">{formatTokens(consoleState.totalTokens)}</span>
			</div>
			<div>
				<span class="l">Cost</span>
				<span class="v">{formatCost(consoleState.totalCostUsd)}</span>
			</div>
			<div>
				<span class="l">Latency</span>
				<span class="v">{consoleState.lastTtftMs ? `${consoleState.lastTtftMs}ms` : '—'}</span>
			</div>
		</div>
	</div>
</aside>
