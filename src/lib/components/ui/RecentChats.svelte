<script lang="ts">
	import { getConversations } from '$lib/chat/chat.remote';

	type Conversation = Awaited<ReturnType<typeof getConversations>>[number];

	let conversations = $state<Conversation[]>([]);

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

	const grouped = $derived.by(() => {
		const now = Date.now();
		const day = 86_400_000;
		const today: Conversation[] = [];
		const week: Conversation[] = [];
		const older: Conversation[] = [];

		for (const c of conversations) {
			const age = now - new Date(c.updatedAt).getTime();
			if (age < day) today.push(c);
			else if (age < day * 7) week.push(c);
			else older.push(c);
		}

		const groups: { label: string; items: Conversation[] }[] = [];
		if (today.length) groups.push({ label: 'Today', items: today });
		if (week.length) groups.push({ label: 'This week', items: week });
		if (older.length) groups.push({ label: 'Older', items: older });
		return groups;
	});
</script>

<div class="flex h-full flex-col">
	<div class="flex items-center justify-between">
		<h2 class="text-xs font-semibold uppercase tracking-[0.16em] text-base-content/55">Chats</h2>
		<a href="/chat" class="text-xs text-primary hover:underline">View all</a>
	</div>

	<div class="mt-3 flex-1 space-y-4 overflow-y-auto">
		{#if conversations.length === 0}
			<p class="py-6 text-center text-sm text-base-content/40">No conversations yet</p>
		{:else}
			{#each grouped as group (group.label)}
				<div>
					<p class="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-base-content/40">{group.label}</p>
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
</div>
