<svelte:head><title>Chat | DrokBot</title></svelte:head>

<script lang="ts">
	import { goto } from '$app/navigation';
	import { tick } from 'svelte';
	import { fade, fly, scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { createConversation, getConversations } from '$lib/chat';
	import ChatComposer from '$lib/components/chat/ChatComposer.svelte';

	let busy = $state(false);
	let prompt = $state('');
	let model = $state('anthropic/claude-sonnet-4');
	let expanded = $state(false);
	let search = $state('');
	let groupMode = $state<'date' | 'category'>('date');

	type Conversation = Awaited<ReturnType<typeof getConversations>>[number];
	let recentChats = $state<Conversation[]>([]);

	$effect(() => {
		void loadRecent();
	});

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

{#if expanded}
	<!-- Expanded session view -->
	<div class="flex min-h-0 flex-1 flex-col px-2 pt-4 sm:px-0 lg:hidden" in:fly={{ y: 60, duration: 350, easing: cubicOut }} out:fade={{ duration: 180 }}>
		<div class="mx-auto flex w-full max-w-2xl flex-1 flex-col space-y-3 overflow-hidden">
			<!-- Sticky header -->
			<div class="shrink-0 space-y-3">
				<div class="flex items-center gap-3">
					<button
						type="button"
						class="btn btn-sm btn-primary gap-1.5 rounded-xl"
					onclick={async () => { expanded = false; search = ''; await tick(); document.querySelector<HTMLTextAreaElement>('.chat-composer-transition textarea')?.focus(); }}
					>
						<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
						</svg>
						New chat
					</button>
					<h1 class="flex-1 text-lg font-semibold">All chats</h1>
					<label class="flex items-center gap-2 text-xs text-base-content/60">
						<span>Group</span>
						<select class="select select-bordered select-xs" bind:value={groupMode} aria-label="Group chats">
							<option value="date">Date</option>
							<option value="category">Category</option>
						</select>
					</label>
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
			<div class="min-h-0 flex-1 space-y-4 overflow-y-auto pb-20">
				{#if filtered.length === 0}
					<p class="py-6 text-center text-sm text-base-content/40">
						{search ? 'No matches' : 'No conversations yet'}
					</p>
				{:else}
					{#each grouped as group (group.label)}
						<div>
							<p class="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-base-content/40">{group.label}</p>
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
			</div>
		</div>
	</div>
{/if}

{#if !expanded}
<!-- Default new-chat view -->
<div class="flex flex-1 flex-col items-center px-2 pt-12 sm:justify-center sm:px-0 sm:pt-0" in:fade={{ duration: 250, delay: 80 }} out:scale={{ start: 0.97, duration: 200, opacity: 0 }}>
	<div class="w-full max-w-2xl space-y-4 text-center sm:space-y-8">
		<!-- Greeting -->
		<div>
			<h1 class="text-2xl font-semibold tracking-tight text-base-content/90 sm:text-4xl">{greeting}, Derek</h1>
			<p class="mt-1 text-sm text-base-content/50 sm:mt-2 sm:text-lg">How can I help you today?</p>
		</div>

		<!-- Input Area -->
		<div class="chat-composer-transition">
			<ChatComposer
				bind:value={prompt}
				{busy}
				{model}
				placeholder="Start a new conversation..."
				onSubmit={(content) => handleNewChat(content)}
				onModelChange={(id) => {
					model = id;
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
			<div class="w-full space-y-2 text-left lg:hidden">
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
{/if}
