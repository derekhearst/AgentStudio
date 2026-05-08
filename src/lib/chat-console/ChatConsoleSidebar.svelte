<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';
	import favicon from '$lib/assets/favicon.svg';
	import { getConversations } from '$lib/chat';
	import { getCredits, refreshCredits } from '$lib/llm/credits.remote';
	import Icon from './Icon.svelte';
	import { useResizableSize } from './use-resize.svelte';
	import { dayKey, dayLabel } from '$lib/util/relative-time';

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

	type LiveRun = {
		id: string;
		conversationId: string;
		state: 'queued' | 'running' | 'waiting_tool_approval' | 'waiting_user_input';
		label?: string | null;
	};

	let { activePath = '/' }: { activePath?: string } = $props();

	let conversations = $state<Conversation[]>([]);
	let liveRuns = $state<Record<string, LiveRun>>({});
	let creditsBalance = $derived(await getCredits());

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
	let filters = $state({ status: 'All', project: 'All', env: 'All', lastActivity: 'All' });
	let groupBy = $state<'Project' | 'Status' | 'Environment' | 'Date' | 'None'>('Date');
	let sortBy = $state<'Recency' | 'Name' | 'Project'>('Recency');

	// Vertical resize for the Chats panel — drag UP grows the panel (sign = -1).
	const chatsHeight = useResizableSize('console:chats-h', 240, 120, 600);

	$effect(() => {
		void loadConversations();
	});

	async function loadConversations() {
		try {
			conversations = await getConversations();
		} catch {
			// remote query may fail before auth — silently no-op for the sidebar
		}
	}

	onMount(() => {
		if (!browser) return;
		const source = new EventSource('/api/chat/monitor');
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

	// dayKey + dayLabel imported from $lib/util/relative-time

	const filtered = $derived.by(() => {
		const q = chatFilter.trim().toLowerCase();
		const isActiveRun = (c: Conversation) => Boolean(runFor(c));
		return conversations.filter((c) => {
			if (q && !(c.title.toLowerCase().includes(q) || (c.lastMessage?.toLowerCase().includes(q)))) return false;
			if (filters.status === 'Active' && !isActiveRun(c)) return false;
			if (filters.status === 'Archived' && isActiveRun(c)) return false;
			return true;
		});
	});

	const sorted = $derived.by(() => {
		const arr = [...filtered];
		if (sortBy === 'Name') return arr.sort((a, b) => a.title.localeCompare(b.title));
		if (sortBy === 'Project') {
			return arr.sort((a, b) => {
				const ap = a.category ?? 'Uncategorized';
				const bp = b.category ?? 'Uncategorized';
				return ap.localeCompare(bp);
			});
		}
		return arr.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
	});

	const grouped = $derived.by(() => {
		if (groupBy === 'None') return [['', sorted] as [string, Conversation[]]];
		if (groupBy === 'Date') {
			const m = new Map<string, { label: string; ts: number; items: Conversation[] }>();
			for (const c of sorted) {
				const key = dayKey(c.updatedAt);
				const existing = m.get(key);
				if (existing) existing.items.push(c);
				else {
					const ds = new Date(c.updatedAt);
					ds.setHours(0, 0, 0, 0);
					m.set(key, { label: dayLabel(c.updatedAt), ts: ds.getTime(), items: [c] });
				}
			}
			return [...m.values()]
				.sort((a, b) => b.ts - a.ts)
				.map((g) => [g.label, g.items] as [string, Conversation[]]);
		}
		const fieldKey: keyof Conversation = groupBy === 'Project' ? 'category' : groupBy === 'Status' ? 'category' : 'category';
		const m = new Map<string, Conversation[]>();
		for (const c of sorted) {
			const key = (c[fieldKey] as string | null) ?? 'Uncategorized';
			if (!m.has(key)) m.set(key, []);
			m.get(key)!.push(c);
		}
		return [...m.entries()];
	});

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
	const navGroups: Array<{ title: string; items: Array<{ label: string; href: string; icon: IconName }> }> = [
		{
			title: 'General',
			items: [
				{ label: 'Chats', href: '/', icon: 'chat' },
				{ label: 'Projects', href: '/projects', icon: 'folder' },
			],
		},
		{
			title: 'System',
			items: [
				{ label: 'Agents', href: '/agents', icon: 'chip' },
				{ label: 'Skills', href: '/skills', icon: 'school' },
				{ label: 'Automations', href: '/automations', icon: 'bolt' },
				{ label: 'Memory', href: '/memory', icon: 'database' },
				{ label: 'Review', href: '/review', icon: 'edit' },
				{ label: 'Settings', href: '/settings', icon: 'cog' },
			],
		},
	];
</script>

<aside class="console-sb">
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

	{#each navGroups as group (group.title)}
		<div class="console-sb__group">
			<div class="console-sb__title">{group.title}</div>
			{#each group.items as item (item.label)}
				<a
					href={item.href}
					class="console-nav-item {isNavActive(item.href) ? 'active' : ''}"
				>
					<span class="ic"><Icon name={item.icon} size={14} /></span>
					<span>{item.label}</span>
				</a>
			{/each}
		</div>
	{/each}

	{#if creditsBalance}
		<button
			type="button"
			class="console-sb__credits"
			title={`OpenRouter credits — click to refresh.\nTotal: ${formatUsd(creditsBalance.totalCredits)}\nUsed: ${formatUsd(creditsBalance.totalUsage)}`}
			onclick={handleRefreshCredits}
		>
			<span class="ic"><Icon name="dollar" size={13} /></span>
			<span class="l">Credits</span>
			<span class="v">{formatUsd(creditsBalance.remaining)}</span>
		</button>
	{/if}

	<!-- Chats panel -->
	<div class="console-sb__chats" style="height:{chatsHeight.value}px;">
		<button
			type="button"
			class="console-resize console-resize--chats is-vert"
			aria-label="Resize chats panel"
			onmousedown={(e) => chatsHeight.startDrag(e, 'y', -1)}
		>
			<span class="console-resize__grip"></span>
		</button>
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
			<a class="console-sb__newchat" href="/" title="New chat" aria-label="New chat">
				<Icon name="plus" size={14} />
			</a>
		</div>

		{#if openMenu}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="console-fmenu" onmouseleave={() => (openMenu = false)}>
				<div class="console-fmenu__row">
					<span class="l">Status</span>
					<select class="console-fmenu__sel" bind:value={filters.status}>
						<option>Active</option>
						<option>Archived</option>
						<option>All</option>
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
			{#each grouped as [label, items] (label || 'flat')}
				{#if label}
					<div class="console-chatgroup">
						<span>{label}</span>
						<span class="ct">{items.length}</span>
					</div>
				{/if}
				{#each items as conversation (conversation.id)}
					{@const run = runFor(conversation)}
					<a
						class="console-chatrow {activeChatId === conversation.id ? 'active' : ''}"
						href={`/chat/${conversation.id}`}
					>
						<span>
							{#if run}
								<span class="pulse-dot"></span>
							{:else}
								<span class="pulse-dot idle"></span>
							{/if}
						</span>
						<span class="t">{conversation.title}</span>
						<span class="s">· {relativeShort(conversation.updatedAt)}</span>
					</a>
				{/each}
			{/each}
			{#if conversations.length === 0}
				<div class="console-chatempty">No conversations yet</div>
			{:else if sorted.length === 0}
				<div class="console-chatempty">No chats match.</div>
			{/if}
		</div>
	</div>
</aside>
