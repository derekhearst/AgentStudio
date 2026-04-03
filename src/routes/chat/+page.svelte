<script lang="ts">
	import { goto } from '$app/navigation';
	import { createConversation, deleteConversation, getConversations } from '$lib/chat/chat.remote';

	type Conversation = Awaited<ReturnType<typeof getConversations>>[number];

	let busy = $state(false);
	let conversations = $state<Conversation[]>([]);

	$effect(() => {
		void loadConversations();
	});

	async function loadConversations() {
		conversations = await getConversations();
	}

	async function handleCreate() {
		if (busy) return;
		busy = true;
		try {
			const created = await createConversation({ title: 'New conversation' });
			await goto(`/chat/${created.id}`);
		} finally {
			busy = false;
		}
	}

	async function handleDelete(id: string, e: MouseEvent) {
		e.preventDefault();
		await deleteConversation(id);
		await loadConversations();
	}

	// Group conversations by category, null/undefined → 'Uncategorized' (shown last)
	const grouped = $derived.by(() => {
		const map = new Map<string, Conversation[]>();
		for (const c of conversations) {
			const key = c.category?.trim() || '__uncategorized__';
			const bucket = map.get(key) ?? [];
			bucket.push(c);
			map.set(key, bucket);
		}

		const entries = [...map.entries()].sort(([a], [b]) => {
			if (a === '__uncategorized__') return 1;
			if (b === '__uncategorized__') return -1;
			return a.localeCompare(b);
		});

		return entries.map(([key, items]) => ({
			label: key === '__uncategorized__' ? 'Uncategorized' : capitalize(key),
			items,
		}));
	});

	function capitalize(s: string) {
		return s.charAt(0).toUpperCase() + s.slice(1);
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
</script>

<section class="mx-auto max-w-3xl space-y-8 py-6">
	<!-- Header + New Chat -->
	<div class="flex items-center justify-between gap-4">
		<div>
			<h1 class="text-3xl font-bold">Chats</h1>
			<p class="mt-1 text-sm opacity-60">Your conversations, grouped by topic.</p>
		</div>
		<button class="btn btn-primary" type="button" onclick={handleCreate} disabled={busy}>
			{busy ? 'Starting…' : '+ New Chat'}
		</button>
	</div>

	{#if conversations.length === 0}
		<div class="rounded-2xl border border-dashed border-base-300 p-12 text-center">
			<p class="text-lg font-medium opacity-60">No conversations yet.</p>
			<p class="mt-1 text-sm opacity-40">Start a new chat to get going.</p>
		</div>
	{:else}
		{#each grouped as group (group.label)}
			<div class="space-y-3">
				<h2 class="text-xs font-semibold uppercase tracking-widest opacity-50">{group.label}</h2>
				{#each group.items as conversation (conversation.id)}
					<a
						href={`/chat/${conversation.id}`}
						class="group block rounded-2xl border border-base-300 bg-base-100 p-4 transition-colors hover:border-primary hover:bg-base-200"
					>
						<div class="flex items-start justify-between gap-3">
							<div class="min-w-0 flex-1">
								<div class="flex items-center gap-2">
									<span class="truncate font-semibold">{conversation.title}</span>
									{#if conversation.category}
										<span class="badge badge-ghost badge-sm shrink-0">{capitalize(conversation.category)}</span>
									{/if}
								</div>
								<p class="mt-1 line-clamp-1 text-sm opacity-60">
									{conversation.lastMessage ?? 'No messages yet'}
								</p>
							</div>
							<div class="flex shrink-0 flex-col items-end gap-1">
								<span class="text-xs opacity-40">{relativeTime(conversation.updatedAt)}</span>
								<button
									class="btn btn-xs btn-ghost opacity-0 transition-opacity group-hover:opacity-100"
									type="button"
									onclick={(e) => handleDelete(conversation.id, e)}
								>
									Delete
								</button>
							</div>
						</div>
					</a>
				{/each}
			</div>
		{/each}
	{/if}
</section>
