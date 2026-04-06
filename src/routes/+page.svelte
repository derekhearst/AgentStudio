<svelte:head><title>Chat | AGENTSTUDIO</title></svelte:head>

<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { tick } from 'svelte';
	import { fade, fly, scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { createConversation, getConversations } from '$lib/chat';
	import { getSettings } from '$lib/settings';
	import ChatComposer from '$lib/chat/ChatComposer.svelte';

	let busy = $state(false);
	let prompt = $state('');
	let model = $state('anthropic/claude-sonnet-4');
	type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
	const REASONING_STORAGE_KEY = 'drokbot:reasoning-effort';
	const VALID_REASONING_EFFORTS: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
	let reasoningEffort = $state<ReasoningEffort>('none');
	let reasoningHydrated = $state(false);
	let modelInitialized = $state(false);
	let expanded = $state(false);
	let search = $state('');
	let groupMode = $state<'date' | 'category'>('date');

	type Conversation = Awaited<ReturnType<typeof getConversations>>[number];
	let recentChats = $state<Conversation[]>([]);

	$effect(() => {
		void loadRecent();
	});

	$effect(() => {
		if (modelInitialized) return;
		void loadDefaultModel();
	});

	$effect(() => {
		if (!browser || reasoningHydrated) return;
		const stored = window.localStorage.getItem(REASONING_STORAGE_KEY);
		if (stored && VALID_REASONING_EFFORTS.includes(stored as ReasoningEffort)) {
			reasoningEffort = stored as ReasoningEffort;
		}
		reasoningHydrated = true;
	});

	$effect(() => {
		if (!browser || !reasoningHydrated) return;
		window.localStorage.setItem(REASONING_STORAGE_KEY, reasoningEffort);
	});

	async function loadDefaultModel() {
		const settings = await getSettings();
		if (settings?.defaultModel) {
			model = settings.defaultModel;
		}
		modelInitialized = true;
	}

	async function loadRecent() {
		recentChats = await getConversations();
	}

	function getGreeting() {
		const hour = new Date().getHours();
		if (hour < 12) return 'Good morning';
		if (hour < 18) return 'Good afternoon';
		return 'Good evening';
	}

	const greeting = getGreeting();

	const filtered = $derived.by(() => {
		const q = search.trim().toLowerCase();
		const sorted = [...recentChats].sort(
			(a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
		);
		if (!q) return sorted;
		return sorted.filter(
			(c) =>
				c.title.toLowerCase().includes(q) ||
				(c.lastMessage && c.lastMessage.toLowerCase().includes(q))
		);
	});

	function formatDayLabel(date: Date) {
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		const target = new Date(date);
		target.setHours(0, 0, 0, 0);
		const dayDiff = Math.round((today.getTime() - target.getTime()) / 86_400_000);
		if (dayDiff === 0) return 'Today';
		if (dayDiff === 1) return 'Yesterday';
		return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
	}

	const grouped = $derived.by(() => {
		if (groupMode === 'category') {
			const categoryMap = new Map<string, Conversation[]>();
			for (const c of filtered) {
				const label = c.category?.trim() || 'Uncategorized';
				const bucket = categoryMap.get(label);
				if (bucket) bucket.push(c);
				else categoryMap.set(label, [c]);
			}
			const labels = [...categoryMap.keys()].sort((a, b) => {
				if (a === 'Uncategorized') return 1;
				if (b === 'Uncategorized') return -1;
				return a.localeCompare(b);
			});
			return labels.map((label) => ({ label, items: categoryMap.get(label) ?? [] }));
		}

		const dateMap = new Map<string, { label: string; timestamp: number; items: Conversation[] }>();
		for (const c of filtered) {
			const updated = new Date(c.updatedAt);
			const key = `${updated.getFullYear()}-${String(updated.getMonth() + 1).padStart(2, '0')}-${String(updated.getDate()).padStart(2, '0')}`;
			const existing = dateMap.get(key);
			if (existing) {
				existing.items.push(c);
			} else {
				const dayStart = new Date(updated);
				dayStart.setHours(0, 0, 0, 0);
				dateMap.set(key, { label: formatDayLabel(updated), timestamp: dayStart.getTime(), items: [c] });
			}
		}
		return [...dateMap.values()].sort((a, b) => b.timestamp - a.timestamp);
	});

	let trayDragY = $state(0);
	let trayDragging = $state(false);
	let trayStartY = 0;
	let trayScrollEl: HTMLDivElement | undefined = $state(undefined);

	function onTrayTouchStart(e: TouchEvent) {
		if (trayScrollEl && trayScrollEl.scrollTop > 0) return;
		trayStartY = e.touches[0].clientY;
		trayDragging = false;
		trayDragY = 0;
	}

	function onTrayTouchMove(e: TouchEvent) {
		const currentY = e.touches[0].clientY;
		const delta = currentY - trayStartY;
		if (delta > 0 && trayScrollEl && trayScrollEl.scrollTop <= 0) {
			trayDragging = true;
			trayDragY = delta;
			e.preventDefault();
		} else if (!trayDragging) {
			return;
		}
	}

	function onTrayTouchEnd() {
		if (trayDragging && trayDragY > 100) {
			closeChatList();
		}
		trayDragY = 0;
		trayDragging = false;
	}

	function closeChatList() {
		expanded = false;
		search = '';
	}

	async function handleNewChat(initialPrompt?: string) {
		if (busy) return;
		busy = true;
		try {
			const trimmedPrompt = initialPrompt?.trim() ?? '';
			const title = trimmedPrompt.slice(0, 80) || 'New conversation';
			const created = await createConversation({ title, model });
			if (trimmedPrompt) {
				await goto(`/chat/${created.id}?prompt=${encodeURIComponent(trimmedPrompt)}`);
			} else {
				await goto(`/chat/${created.id}`);
			}
		} finally {
			busy = false;
		}
	}
</script>

<div class="relative flex min-h-0 flex-1 flex-col overflow-hidden">
<!-- Default new-chat view (always rendered) -->
<div class="flex flex-1 flex-col items-center px-2 pt-12 tablet:justify-center tablet:px-0 tablet:pt-0">
	<div class="w-full max-w-2xl space-y-4 text-center tablet:space-y-8">
		<!-- Greeting -->
		<div>
			<h1 class="text-2xl font-semibold tracking-tight text-base-content/90 tablet:text-4xl">{greeting}, Derek</h1>
			<p class="mt-1 text-sm text-base-content/50 tablet:mt-2 tablet:text-lg">How can I help you today?</p>
		</div>

		<!-- Input Area -->
		<div class="chat-composer-transition">
			<ChatComposer
				bind:value={prompt}
				{busy}
				{model}
				reasoningEffort={reasoningEffort}
				placeholder="Start a new conversation..."
				onSubmit={(content) => handleNewChat(content)}
				onModelChange={(id) => {
					model = id;
				}}
				onReasoningEffortChange={(next) => {
					reasoningEffort = next;
				}}
				onAddFiles={() => {
					// File picker hook will be wired in a later pass.
				}}
				onMicClick={() => {
					// Voice capture hook will be wired in a later pass.
				}}
			/>
		</div>

		<!-- Recent chats (visible when sidebar is hidden) -->
		{#if recentChats.length > 0}
			<div class="w-full space-y-2 text-left desktop:hidden">
				<h2 class="text-xs font-semibold uppercase tracking-wide text-base-content/40">Recent chats</h2>
				<div class="space-y-0.5">
					{#each recentChats.slice(0, 5) as chat (chat.id)}
						<a
							href={`/chat/${chat.id}`}
							class="flex items-baseline gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-base-200"
						>
							<span class="min-w-0 flex-1 truncate font-medium">{chat.title}</span>
							<span class="shrink-0 text-[11px] text-base-content/40">
								{new Date(chat.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
							</span>
						</a>
					{/each}
				</div>
				{#if recentChats.length > 5}
					<button
						type="button"
						class="btn btn-ghost btn-sm w-full text-base-content/50 view-all-btn"
						onclick={() => (expanded = true)}
					>
						View all {recentChats.length} chats
					</button>
				{/if}
			</div>
		{/if}
	</div>
</div>

<!-- Chat tray — slides up from bottom, overlays the content -->
{#snippet ChatGroups()}
	{#if filtered.length === 0}
		<p class="py-6 text-center text-sm text-base-content/40">
			{search ? 'No matches' : 'No conversations yet'}
		</p>
	{:else}
		{#each grouped as group (group.label)}
			<div>
				<p class="mb-2 text-xs font-semibold uppercase tracking-wider text-base-content/50">{group.label}</p>
				<div class="space-y-0.5">
					{#each group.items as chat (chat.id)}
						<a
							href={`/chat/${chat.id}`}
							class="chat-list-item block rounded-xl px-2.5 py-2 text-sm transition-colors hover:bg-base-200"
						>
							<span class="line-clamp-1 font-medium">{chat.title}</span>
							<span class="mt-0.5 line-clamp-1 text-xs text-base-content/50">
								{chat.lastMessage ?? 'No messages yet'}
							</span>
						</a>
					{/each}
				</div>
			</div>
		{/each}
	{/if}
{/snippet}

{#if expanded}
	<!-- Scrim -->
	<button
		type="button"
		class="chat-tray-scrim fixed inset-0 z-10"
		onclick={closeChatList}
		aria-label="Close chat list"
		transition:fade={{ duration: 200 }}
	></button>

	<!-- Tray panel -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="chat-tray fixed inset-x-0 bottom-0 z-20 flex max-h-[80vh] flex-col rounded-t-2xl border-t border-base-300 bg-base-100/95 pb-14 shadow-2xl backdrop-blur-xl tablet:rounded-t-3xl desktop:pb-0 tablet:hidden"
		style="transform: translateY({trayDragging && trayDragY > 0 ? trayDragY + 'px' : '0'}); transition: {trayDragging ? 'none' : 'transform 200ms ease-out'};"
		transition:fly={{ y: 400, duration: 380, easing: cubicOut }}
		ontouchstart={onTrayTouchStart}
		ontouchmove={onTrayTouchMove}
		ontouchend={onTrayTouchEnd}
	>
		<!-- Drag handle -->
		<div class="flex shrink-0 justify-center pb-1 pt-3">
			<div class="h-1 w-10 rounded-full bg-base-content/20"></div>
		</div>

		<!-- Header -->
		<div class="shrink-0 space-y-3 px-4 pb-3">
			<div class="flex items-center gap-3">
				<h2 class="flex-1 text-lg font-semibold">All chats</h2>
				<div class="join" role="group" aria-label="Group chats">
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

		<!-- Scrollable list -->
		<div bind:this={trayScrollEl} class="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-none px-4 pb-6">
			{@render ChatGroups()}
		</div>
	</div>

	<!-- Tablet modal panel -->
	<div class="fixed inset-0 z-20 hidden px-5 py-8 tablet:flex desktop:hidden" transition:fade={{ duration: 180 }}>
		<div class="mx-auto flex h-full w-full max-w-4xl items-stretch">
			<div
				class="flex w-full min-h-0 flex-col overflow-hidden rounded-3xl border border-base-300 bg-base-100/95 shadow-2xl backdrop-blur-xl"
				transition:scale={{ duration: 220, start: 0.96, easing: cubicOut }}
			>
				<div class="shrink-0 border-b border-base-300/70 px-6 py-5">
					<div class="flex items-center gap-4">
						<div class="min-w-0 flex-1">
							<p class="text-xs font-semibold uppercase tracking-[0.14em] text-base-content/45">Conversation browser</p>
							<h2 class="mt-1 text-2xl font-semibold tracking-tight">All chats</h2>
						</div>
						<span class="badge badge-outline badge-lg">{filtered.length}</span>
						<button type="button" class="btn btn-ghost btn-sm" onclick={closeChatList} aria-label="Close chat list">Close</button>
					</div>
					<div class="mt-4 flex items-center gap-3">
						<div class="join" role="group" aria-label="Group chats">
							<button
								class="join-item btn btn-sm {groupMode === 'date' ? 'btn-primary' : 'btn-ghost'}"
								onclick={() => (groupMode = 'date')}
							>Date</button>
							<button
								class="join-item btn btn-sm {groupMode === 'category' ? 'btn-primary' : 'btn-ghost'}"
								onclick={() => (groupMode = 'category')}
							>Category</button>
						</div>
						<input
							type="text"
							class="input input-bordered w-full"
							placeholder="Search chats…"
							bind:value={search}
							aria-label="Search chats"
						/>
					</div>
				</div>
				<div class="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-6 pt-4">
					{@render ChatGroups()}
				</div>
			</div>
		</div>
	</div>
{/if}
</div>

