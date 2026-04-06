<script lang="ts">
	import { getConversations } from '$lib/chat';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';
	import { getAvailableModels } from '$lib/models';
	import { page } from '$app/state';

	type Conversation = Awaited<ReturnType<typeof getConversations>>[number];
	type GroupMode = 'date' | 'category';

	let conversations = $state<Conversation[]>([]);
	let groupMode = $state<GroupMode>('date');
	let search = $state('');
	let availableModels = $derived(await getAvailableModels());

	$effect(() => {
		void loadConversations();
	});

	async function loadConversations() {
		conversations = await getConversations();
	}

	function relativeTime(date: Date | string) {
		const diff = Date.now() - new Date(date).getTime();
		const minutes = Math.floor(diff / 60_000);
		if (minutes < 1) return 'just now';
		if (minutes < 60) return `${minutes}m ago`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}h ago`;
		const days = Math.floor(hours / 24);
		return `${days}d ago`;
	}

	function formatDayLabel(date: Date) {
		const today = new Date();
		today.setHours(0, 0, 0, 0);

		const target = new Date(date);
		target.setHours(0, 0, 0, 0);

		const dayDiff = Math.round((today.getTime() - target.getTime()) / 86_400_000);
		if (dayDiff === 0) return 'Today';
		if (dayDiff === 1) return 'Yesterday';

		return new Intl.DateTimeFormat(undefined, {
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		}).format(date);
	}

	function dayKey(date: Date | string) {
		const d = new Date(date);
		const y = d.getFullYear();
		const m = String(d.getMonth() + 1).padStart(2, '0');
		const day = String(d.getDate()).padStart(2, '0');
		return `${y}-${m}-${day}`;
	}

	const filtered = $derived.by(() => {
		const q = search.trim().toLowerCase();
		if (!q) return conversations;
		return conversations.filter(
			(c) =>
				c.title.toLowerCase().includes(q) ||
				(c.lastMessage && c.lastMessage.toLowerCase().includes(q))
		);
	});

	const grouped = $derived.by(() => {
		const sorted = [...filtered].sort(
			(a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
		);

		if (groupMode === 'category') {
			const categoryMap = new Map<string, Conversation[]>();
			for (const c of sorted) {
				const label = c.category?.trim() || 'Uncategorized';
				const bucket = categoryMap.get(label);
				if (bucket) {
					bucket.push(c);
				} else {
					categoryMap.set(label, [c]);
				}
			}

			const labels = [...categoryMap.keys()].sort((a, b) => {
				if (a === 'Uncategorized') return 1;
				if (b === 'Uncategorized') return -1;
				return a.localeCompare(b);
			});

			return labels.map((label) => ({
				label,
				items: categoryMap.get(label) ?? []
			}));
		}

		const dateMap = new Map<string, { label: string; timestamp: number; items: Conversation[] }>();
		for (const c of sorted) {
			const updated = new Date(c.updatedAt);
			const key = dayKey(updated);
			const existing = dateMap.get(key);
			if (existing) {
				existing.items.push(c);
			} else {
				const dayStart = new Date(updated);
				dayStart.setHours(0, 0, 0, 0);
				dateMap.set(key, {
					label: formatDayLabel(updated),
					timestamp: dayStart.getTime(),
					items: [c]
				});
			}
		}

		return [...dateMap.values()]
			.sort((a, b) => b.timestamp - a.timestamp)
			.map((group) => ({
				label: group.label,
				items: group.items
			}));
	});

	const activeConversationId = $derived.by(() => {
		const match = /^\/chat\/([^/]+)$/.exec(page.url.pathname);
		return match?.[1] ?? null;
	});

	const sidebarContext = $derived.by(() => {
		const current = activeConversationId
			? conversations.find((conversation) => conversation.id === activeConversationId)
			: null;
		if (!current) {
			return {
				visible: false,
				pct: 0,
				used: 0,
				total: 0,
				label: 'No active chat',
				breakdown: null as { system: number; tools: number; messages: number; results: number; other: number } | null
			};
		}

		const selectedModel = availableModels.find((model) => model.id === current.model);
		const total = selectedModel?.contextLength && selectedModel.contextLength > 0
			? selectedModel.contextLength
			: 200000;
		const used = Math.max(0, Math.min(total, current.totalTokens ?? 0));
		const pct = total > 0 ? Math.max(0, Math.min(100, (used / total) * 100)) : 0;

		const toPct = (v: number) => total > 0 ? Math.max(0, Number(((v / total) * 100).toFixed(1))) : 0;
		const systemTokens = Math.min(used, 900);
		const toolTokens = Math.min(Math.max(0, used - systemTokens), 900);
		const messageTokens = Math.max(0, used - systemTokens - toolTokens);

		return {
			visible: true,
			pct,
			used,
			total,
			label: `${Math.round(pct)}%`,
			breakdown: {
				system: toPct(systemTokens),
				tools: toPct(toolTokens),
				messages: toPct(messageTokens),
				results: 0,
				other: 0
			}
		};
	});
</script>

<ContentPanel bare compact flush>
	{#snippet header()}
		<div class="w-full space-y-3 pb-3">
			<div class="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
				<div class="justify-self-start">
					<a href="/" class="btn btn-xs btn-primary" aria-label="Start a new chat">New Chat</a>
				</div>
				<h1 class="justify-self-center text-xl font-bold sm:text-2xl">Chats</h1>
				<div class="join justify-self-end" role="group" aria-label="Group chats">
					<button
						class="join-item btn btn-xs {groupMode === 'date' ? 'btn-primary' : 'btn-ghost'}"
						onclick={() => (groupMode = 'date')}
					>Date</button>
					<button
						class="join-item btn btn-xs {groupMode === 'category' ? 'btn-primary' : 'btn-ghost'}"
						onclick={() => (groupMode = 'category')}
					>Category</button>
				</div>
			</div>
			<input
				type="text"
				class="input input-bordered input-sm w-full"
				placeholder="Search chats…"
				bind:value={search}
				aria-label="Search chats"
			/>
		</div>
	{/snippet}

	<div class="mt-3 space-y-5">
		{#if conversations.length === 0}
			<p class="py-6 text-center text-sm text-base-content/40">No conversations yet</p>
		{:else}
			{#each grouped as group (group.label)}
				<div>
					<p class="mb-2 text-xs font-semibold uppercase tracking-wider text-base-content/50">{group.label}</p>
					<div class="space-y-1">
						{#each group.items as conversation (conversation.id)}
							<a
								href={`/chat/${conversation.id}`}
								class="block rounded-xl px-2.5 py-2 text-sm transition-colors hover:bg-base-200"
							>
								<span class="line-clamp-1 font-medium">{conversation.title}</span>
								<span class="mt-0.5 line-clamp-1 text-xs text-base-content/50">
									{conversation.lastMessage ?? 'No messages yet'}
								</span>
							</a>
						{/each}
					</div>
				</div>
			{/each}
		{/if}
	</div>

	{#snippet footer()}
		{#if sidebarContext.visible}
			{@const reservedTargetPct = 30}
			{@const reservedStart = Math.min(100, sidebarContext.pct)}
			{@const reservedPct = Math.max(0, Math.min(reservedTargetPct, 100 - sidebarContext.pct))}
			{@const usedK = (sidebarContext.used / 1000).toFixed(1)}
			{@const totalK = (sidebarContext.total / 1000).toFixed(0)}
			{@const bd = sidebarContext.breakdown}
			<div class="dropdown dropdown-top dropdown-hover w-full">
				<div
					tabindex="0"
					role="button"
					class="w-full cursor-default space-y-1.5 rounded-xl border border-base-300/60 bg-base-100/70 p-2.5"
					aria-label={`Context window ${sidebarContext.label}`}
				>
					<div class="flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-base-content/60">
						<span>Context</span>
						<span class="tabular-nums">{sidebarContext.label}</span>
					</div>
					<div class="relative h-2 overflow-hidden rounded-full border border-base-300/60 bg-base-200/70">
						<div class="absolute inset-y-0 left-0 bg-primary/75" style={`width:${sidebarContext.pct}%`}></div>
						<div class="ctx-reserved-bar absolute inset-y-0" style={`left:${reservedStart}%; width:${reservedPct}%`}></div>
					</div>
					<p class="text-[11px] tabular-nums text-base-content/55">
						{sidebarContext.used.toLocaleString()} / {sidebarContext.total.toLocaleString()} tokens
					</p>
				</div>

				<div tabindex="-1" class="dropdown-content z-30 mb-2 w-full">
					<div class="rounded-xl border border-base-300 bg-base-100/95 p-3 text-sm shadow-xl backdrop-blur">
						<h3 class="mb-1 text-base font-semibold">Context Window</h3>
						<p class="font-mono text-xs opacity-80">{usedK}K / {totalK}K tokens</p>

						<div class="mt-2 flex items-center gap-2">
							<div class="relative h-2 flex-1 overflow-hidden rounded-full border border-base-300/60 bg-base-200/70">
								<div class="absolute inset-y-0 left-0 bg-primary/75" style={`width:${sidebarContext.pct}%`}></div>
								<div class="ctx-reserved-bar absolute inset-y-0" style={`left:${reservedStart}%; width:${reservedPct}%`}></div>
							</div>
							<span class="w-10 text-right text-xs tabular-nums opacity-75">{sidebarContext.label}</span>
						</div>

						<div class="mt-2 flex items-center gap-2 text-xs opacity-75">
							<span class="inline-block h-2.5 w-2.5 rounded-[2px] border border-primary/70 bg-primary/70"></span>
							<span>Used by prompt</span>
						</div>
						<div class="mt-1 flex items-center gap-2 text-xs opacity-75">
							<span class="ctx-reserved-legend inline-block h-2.5 w-2.5 rounded-[2px] border border-primary/50"></span>
							<span>Reserved for response</span>
							<span class="ml-auto tabular-nums">{reservedPct.toFixed(1)}%</span>
						</div>

						<div class="mt-3 space-y-1">
							<p class="text-xs font-semibold uppercase tracking-wide opacity-60">Model Usage</p>
							<div class="mt-1 flex h-2 overflow-hidden rounded-full border border-base-300/60 bg-base-200/70"></div>
							<p class="text-xs opacity-60">No model usage yet</p>
						</div>

						{#if bd}
							<div class="mt-3 space-y-1">
								<p class="text-xs font-semibold uppercase tracking-wide opacity-60">System</p>
								<div class="flex items-center justify-between text-sm">
									<span class="opacity-85">System Instructions</span>
									<span class="tabular-nums opacity-75">{bd.system.toFixed(1)}%</span>
								</div>
								<div class="flex items-center justify-between text-sm">
									<span class="opacity-85">Tool Definitions</span>
									<span class="tabular-nums opacity-75">{bd.tools.toFixed(1)}%</span>
								</div>
							</div>

							<div class="mt-3 space-y-1">
								<p class="text-xs font-semibold uppercase tracking-wide opacity-60">User Context</p>
								<div class="flex items-center justify-between text-sm">
									<span class="opacity-85">Messages</span>
									<span class="tabular-nums opacity-75">{bd.messages.toFixed(1)}%</span>
								</div>
								<div class="flex items-center justify-between text-sm">
									<span class="opacity-85">Tool Results</span>
									<span class="tabular-nums opacity-75">{bd.results.toFixed(1)}%</span>
								</div>
							</div>

							<div class="mt-3 space-y-1">
								<p class="text-xs font-semibold uppercase tracking-wide opacity-60">Uncategorized</p>
								<div class="flex items-center justify-between text-sm">
									<span class="opacity-85">Other</span>
									<span class="tabular-nums opacity-75">{bd.other.toFixed(1)}%</span>
								</div>
							</div>
						{/if}
					</div>
				</div>
			</div>
		{/if}
	{/snippet}
</ContentPanel>

<style>
	.ctx-reserved-bar {
		background-image: repeating-linear-gradient(
			-45deg,
			color-mix(in oklab, var(--color-primary) 60%, transparent) 0,
			color-mix(in oklab, var(--color-primary) 60%, transparent) 2px,
			transparent 2px,
			transparent 6px
		);
	}

	.ctx-reserved-legend {
		background-image: repeating-linear-gradient(
			-45deg,
			color-mix(in oklab, var(--color-primary) 65%, transparent) 0,
			color-mix(in oklab, var(--color-primary) 65%, transparent) 2px,
			transparent 2px,
			transparent 5px
		);
	}
</style>

