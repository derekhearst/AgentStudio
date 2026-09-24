<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';
	import favicon from '$lib/assets/favicon.svg';
	import { getArchivedConversations, getConversations, searchConversations } from '$lib/chat';
	import { onConversationListChange } from '$lib/chat/conversation-list-sync';
	import { SEARCH_QUERY_MAX_CHARS, SEARCH_QUERY_MIN_CHARS, splitSnippet } from '$lib/chat/conversation-search';
	import { fetchFresh } from '$lib/ui/fresh-query';
	import { page } from '$app/state';
	import { getCredits, refreshCredits } from '$lib/llm/credits.remote';
	import Icon from './Icon.svelte';
	import ConversationRowMenu from './ConversationRowMenu.svelte';
	import { groupConversations, listTime, type ConversationListView } from '$lib/chat/conversation-order';

	const THEME_STORAGE_KEY = 'AgentStudio-theme';
	let isDark = $state(true);
	if (browser) {
		const saved = localStorage.getItem(THEME_STORAGE_KEY);
		if (saved === 'AgentStudio' || saved === 'AgentStudio-night') {
			isDark = saved === 'AgentStudio-night';
		} else {
			isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
		}
	}
	function toggleTheme() {
		isDark = !isDark;
		if (!browser) return;
		const next = isDark ? 'AgentStudio-night' : 'AgentStudio';
		localStorage.setItem(THEME_STORAGE_KEY, next);
		document.documentElement.setAttribute('data-theme', next);
	}

	type Conversation = Awaited<ReturnType<typeof getConversations>>[number];
	type SearchHit = Awaited<ReturnType<typeof searchConversations>>[number];

	type LiveRun = {
		id: string;
		conversationId: string;
		state: 'queued' | 'running' | 'waiting_tool_approval' | 'waiting_user_input';
		label?: string | null;
	};

	let {
		activePath = '/',
		onNavigate,
		variant = 'sidebar',
	}: {
		activePath?: string;
		onNavigate?: () => void;
		variant?: 'sidebar' | 'drawer';
	} = $props();

	let liveRuns = $state<Record<string, LiveRun>>({});
	/**
	 * Belt and braces alongside the layout's chromeless routes: `getCredits` is an
	 * authenticated query, and calling it without a session throws 401 during SSR — which
	 * takes down the whole page, not just the balance. The shell should not render on a
	 * public route at all, but a nav that hard-fails when it does is a sharp edge worth
	 * removing rather than relying on one guard.
	 */
	const authenticated = $derived(page.data?.authenticated === true);
	let creditsBalance = $derived(authenticated ? await getCredits() : null);

	/*
	 * Read reactively rather than copied out once (#79): this nav lives for the whole session,
	 * so a list read on mount never showed a new chat, a generated title or a new order. A
	 * failed read (no session yet) is just an empty list, as before.
	 */
	const conversationsQuery = $derived(browser && authenticated ? getConversations() : null);

	function formatUsd(value: number): string {
		if (value >= 100) return `$${value.toFixed(0)}`;
		if (value >= 1) return `$${value.toFixed(2)}`;
		return `$${value.toFixed(3)}`;
	}

	async function handleRefreshCredits(event: MouseEvent) {
		event.preventDefault();
		event.stopPropagation();
		try {
			await refreshCredits();
			await getCredits().refresh();
		} catch {
			/* widget is best-effort */
		}
	}
	let chatFilter = $state('');
	let openMenu = $state(false);
	/** `All` is every unarchived chat, `Running` those with a live turn, `Archived` the archive (#18). */
	let filters = $state({ status: 'All', project: 'All', env: 'All', lastActivity: 'All' });
	let groupBy = $state<'Project' | 'Status' | 'Environment' | 'Date' | 'None'>('Date');
	let sortBy = $state<'Recency' | 'Name' | 'Project'>('Recency');

	/*
	 * #18 — the archive is its own list, read only while it is being looked at. The default
	 * list leaves archived chats out on the server.
	 */
	const showingArchive = $derived(filters.status === 'Archived');
	const archivedQuery = $derived(browser && authenticated && showingArchive ? getArchivedConversations() : null);
	const conversations = $derived<Conversation[]>(
		(showingArchive ? archivedQuery?.current : conversationsQuery?.current) ?? [],
	);

	onMount(() => {
		if (!browser) return;
		const source = new EventSource('/api/chat/monitor');
		onConversationListChange(source, () =>
			Promise.all([getConversations().refresh(), showingArchive ? getArchivedConversations().refresh() : null]),
		);
		source.onmessage = (event) => {
			try {
				const runs = JSON.parse(event.data) as LiveRun[];
				const next: Record<string, LiveRun> = {};
				for (const run of runs) next[run.conversationId] = run;
				liveRuns = next;
			} catch {
				/* ignore malformed payloads */
			}
		};
		return () => source.close();
	});

	function runFor(conversation: Conversation): LiveRun | null {
		return liveRuns[conversation.id] ?? (conversation.activeRun ? { ...conversation.activeRun, conversationId: conversation.id } as LiveRun : null);
	}

	function relativeShort(date: Date | string) {
		const diff = Date.now() - new Date(date).getTime();
		const m = Math.floor(diff / 60_000);
		if (m < 1) return 'now';
		if (m < 60) return `${m}m`;
		const h = Math.floor(m / 60);
		if (h < 24) return `${h}h`;
		const d = Math.floor(h / 24);
		return `${d}d`;
	}

	const filtered = $derived.by(() => {
		const q = chatFilter.trim().toLowerCase();
		const isActiveRun = (c: Conversation) => Boolean(runFor(c));
		return conversations.filter((c) => {
			if (q && !(c.title.toLowerCase().includes(q) || (c.lastMessage?.toLowerCase().includes(q)))) return false;
			if (filters.status === 'Running' && !isActiveRun(c)) return false;
			return true;
		});
	});

	/*
	 * #18 — the order is `$lib/chat/conversation-order`'s: pinned chats on top by when they were
	 * pinned, the archive by when each chat was archived, everything else by last activity.
	 */
	const listView = $derived<ConversationListView>(showingArchive ? 'archive' : 'chats');
	const grouped = $derived(groupConversations(filtered, { sortBy, groupBy, view: listView }));

	/*
	 * #18 — search in messages and tool calls, on the server. The filter above stays instant
	 * over the loaded titles; this runs a quarter-second after typing stops, and finds chats
	 * the list does not hold (older than the recent 50, or archived while the archive is open).
	 */
	let searchHits = $state<SearchHit[]>([]);
	let searchStatus = $state<'idle' | 'loading' | 'done' | 'error'>('idle');
	let searchNonce = $state(0);
	let searchSeq = 0;

	$effect(() => {
		const q = chatFilter.trim().slice(0, SEARCH_QUERY_MAX_CHARS);
		const includeArchived = showingArchive;
		void searchNonce;
		const seq = ++searchSeq;
		if (!browser || !authenticated || q.length < SEARCH_QUERY_MIN_CHARS) {
			searchHits = [];
			searchStatus = 'idle';
			return;
		}
		searchStatus = 'loading';
		const timer = setTimeout(async () => {
			try {
				const hits = await fetchFresh(searchConversations({ q, includeArchived }));
				if (seq !== searchSeq) return;
				searchHits = hits;
				searchStatus = 'done';
			} catch {
				if (seq !== searchSeq) return;
				searchHits = [];
				searchStatus = 'error';
			}
		}, 250);
		return () => clearTimeout(timer);
	});

	/** Server hits worth showing: a matching message, or a title the loaded list does not hold. */
	const messageHits = $derived.by(() => {
		const shown = new Set(filtered.map((c) => c.id));
		return searchHits.filter((hit) => hit.match || !shown.has(hit.conversationId));
	});

	function rerunSearch() {
		searchNonce += 1;
	}

	const activeChatId = $derived.by(() => {
		const match = /^\/chat\/([^/]+)$/.exec(activePath);
		return match?.[1] ?? null;
	});

	function isNavActive(href: string): boolean {
		if (href === '/') return activePath === '/' || activePath.startsWith('/chat');
		return activePath.startsWith(href);
	}

	type IconName =
		| 'chat' | 'chip' | 'school' | 'bolt' | 'check' | 'folder' | 'dollar'
		| 'database' | 'edit' | 'cog';
	type NavItem = { label: string; href: string; icon: IconName };

	/**
	 * Sidebar hierarchy follows what actually gets used: chats dominate, the
	 * places you browse content sit just above them, and everything
	 * configuration-shaped is folded into the footer disclosure rather than
	 * taking six permanent rows above the chat list.
	 */
	const primaryNav: NavItem[] = [
		{ label: 'Chats', href: '/', icon: 'chat' },
		{ label: 'Projects', href: '/projects', icon: 'folder' },
	];

	const systemNav: NavItem[] = [
		{ label: 'Agents', href: '/agents', icon: 'chip' },
		{ label: 'Skills', href: '/skills', icon: 'school' },
		{ label: 'Automations', href: '/automations', icon: 'bolt' },
		{ label: 'Memory', href: '/memory', icon: 'database' },
		{ label: 'Review', href: '/review', icon: 'edit' },
		{ label: 'Settings', href: '/settings', icon: 'cog' },
	];

	// Keep the drawer open when the user is already inside one of those sections.
	let systemOpen = $state(systemNav.some((item) => isNavActive(item.href)));
</script>

<div class="console-sb__head">
	<img src={favicon} width="22" height="22" alt="" />
	<span class="console-sb__brand"><span class="lt">Agent</span><span class="bd">Studio</span></span>
	<button
		type="button"
		class="console-sb__theme"
		onclick={toggleTheme}
		aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
		title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
	>
		<Icon name={isDark ? 'sun' : 'moon'} size={14} />
	</button>
</div>

<a class="console-sb__newbtn" href="/" onclick={onNavigate}>
	<Icon name="plus" size={14} />
	<span>New chat</span>
</a>

<div class="console-sb__group">
	{#each primaryNav as item (item.label)}
		<a
			href={item.href}
			class="console-nav-item {isNavActive(item.href) ? 'active' : ''}"
			onclick={onNavigate}
		>
			<span class="ic"><Icon name={item.icon} size={14} /></span>
			<span>{item.label}</span>
		</a>
	{/each}
</div>

<!-- Chats panel -->
<div class="console-sb__chats {variant === 'drawer' ? 'is-drawer' : ''}">
	<div class="console-sb__search">
		<Icon name="search" size={13} />
		<input
			type="text"
			placeholder="Search…"
			bind:value={chatFilter}
			aria-label="Search chats"
		/>
	</div>

	<div class="console-sb__chats-row">
		<button type="button" class="console-sb__filterbtn" onclick={() => (openMenu = !openMenu)}>
			<span class="sum">
				{filters.status} · {groupBy}
			</span>
			<span class="car">▾</span>
		</button>
	</div>

	{#if openMenu}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="console-fmenu" onmouseleave={() => (openMenu = false)}>
			<div class="console-fmenu__row">
				<span class="l">Status</span>
				<select class="console-fmenu__sel" bind:value={filters.status} aria-label="Status">
					<option>All</option>
					<option>Running</option>
					<option>Archived</option>
				</select>
			</div>
			<div class="console-fmenu__sep"></div>
			<div class="console-fmenu__row">
				<span class="l">Group by</span>
				<select class="console-fmenu__sel" bind:value={groupBy}>
					<option>Date</option>
					<option>Project</option>
					<option>Status</option>
					<option>None</option>
				</select>
			</div>
			<div class="console-fmenu__row">
				<span class="l">Sort by</span>
				<select class="console-fmenu__sel" bind:value={sortBy}>
					<option>Recency</option>
					<option>Name</option>
					<option>Project</option>
				</select>
			</div>
		</div>
	{/if}

	<div class="console-sb__chatlist">
		{#if showingArchive}
			<div class="console-archivebar">
				<span>Archived chats</span>
				<button type="button" onclick={() => (filters.status = 'All')}>Back to chats</button>
			</div>
		{/if}
		{#each grouped as group (group.key)}
			{#if group.label}
				<div class="console-chatgroup {group.key === 'pinned' ? 'is-pinned' : ''}">
					<span>{group.label}</span>
					<span class="ct">{group.items.length}</span>
				</div>
			{/if}
			{#each group.items as conversation (conversation.id)}
				{@const run = runFor(conversation)}
				<div class="console-chatitem" data-conversation-id={conversation.id}>
					<a
						class="console-chatrow {activeChatId === conversation.id ? 'active' : ''}"
						href={`/chat/${conversation.id}`}
						onclick={onNavigate}
					>
						<span>
							{#if run}
								<span class="pulse-dot"></span>
							{:else}
								<span class="pulse-dot idle"></span>
							{/if}
						</span>
						<span class="t">{conversation.title}</span>
						<span class="s">· {relativeShort(listTime(conversation, listView))}</span>
					</a>
					<ConversationRowMenu
						{conversation}
						active={activeChatId === conversation.id}
						onChanged={rerunSearch}
						{onNavigate}
					/>
				</div>
			{/each}
		{/each}
		{#if conversations.length === 0 && messageHits.length === 0}
			<div class="console-chatempty">{showingArchive ? 'Nothing archived.' : 'No conversations yet'}</div>
		{:else if filtered.length === 0 && searchStatus === 'idle'}
			<!-- Once the server search runs, its own section says whether anything matched. -->
			<div class="console-chatempty">No chats match.</div>
		{/if}

		{#if searchStatus !== 'idle'}
			<section class="console-searchhits" aria-label="Search results in messages">
				<div class="console-chatgroup">
					<span>In messages</span>
					<span class="ct">{searchStatus === 'loading' ? '…' : messageHits.length}</span>
				</div>
				{#if searchStatus === 'error'}
					<div class="console-chatempty">Search failed. Try again.</div>
				{:else if searchStatus === 'done' && messageHits.length === 0}
					<div class="console-chatempty">Nothing found in messages.</div>
				{/if}
				{#each messageHits as hit (hit.conversationId)}
					{@const when = new Date(hit.match?.createdAt ?? hit.updatedAt)}
					<a
						class="console-searchhit {activeChatId === hit.conversationId ? 'active' : ''}"
						href={`/chat/${hit.conversationId}`}
						onclick={onNavigate}
					>
						<span class="console-searchhit__head">
							<span class="t">{hit.title}</span>
							{#if hit.archived}
								<span class="console-searchhit__badge">archived</span>
							{/if}
							<time class="s" datetime={when.toISOString()} title={when.toLocaleString()}>{relativeShort(when)}</time>
						</span>
						{#if hit.match}
							<!-- One line on purpose: whitespace in the markup would pad every highlight. -->
							<span class="console-searchhit__snippet">{#each splitSnippet(hit.match.snippet) as part, i (i)}{#if part.mark}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</span>
						{/if}
					</a>
				{/each}
			</section>
		{/if}
	</div>
</div>

<div class="console-sb__foot">
	<button
		type="button"
		class="console-sb__more"
		aria-expanded={systemOpen}
		onclick={() => (systemOpen = !systemOpen)}
	>
		<span class="ic"><Icon name="cog" size={13} /></span>
		<span>Manage</span>
		<span class="car">{systemOpen ? '▾' : '▸'}</span>
	</button>

	{#if systemOpen}
		<div class="console-sb__moreitems">
			{#each systemNav as item (item.label)}
				<a
					href={item.href}
					class="console-nav-item {isNavActive(item.href) ? 'active' : ''}"
					onclick={onNavigate}
				>
					<span class="ic"><Icon name={item.icon} size={14} /></span>
					<span>{item.label}</span>
				</a>
			{/each}
		</div>
	{/if}

	{#if creditsBalance}
		<button
			type="button"
			class="console-sb__credits"
			title={`OpenRouter credits — click to refresh.
Total: ${formatUsd(creditsBalance.totalCredits)}
Used: ${formatUsd(creditsBalance.totalUsage)}`}
			onclick={handleRefreshCredits}
		>
			<span class="ic"><Icon name="dollar" size={13} /></span>
			<span class="l">Credits</span>
			<span class="v">{formatUsd(creditsBalance.remaining)}</span>
		</button>
	{/if}
</div>
