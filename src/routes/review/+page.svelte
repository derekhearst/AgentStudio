<svelte:head><title>Review | AgentStudio</title></svelte:head>

<script lang="ts">
	import ContentPanel from '$lib/ui/ContentPanel.svelte';
	import { getConversations } from '$lib/chat';
	import { getAgentChoices } from '$lib/agents';

	let conversations = $state<Awaited<ReturnType<typeof getConversations>>>([]);
	let agents = $state<Awaited<ReturnType<typeof getAgentChoices>>>([]);

	$effect(() => {
		void load();
	});

	async function load() {
		const [convs, agts] = await Promise.all([getConversations(), getAgentChoices()]);
		agents = agts;
		// Show conversations that have agent activity (agentId set or orchestrator chats)
		conversations = convs
			.filter((c) => c.agentId || c.totalCost !== '0')
			.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
	}

	function agentName(agentId: string | null): string {
		if (!agentId) return 'Orchestrator';
		return agents.find((a) => a.id === agentId)?.name ?? 'Agent';
	}
</script>

<ContentPanel>
	{#snippet header()}
		<div>
			<h1 class="text-2xl font-bold">Review</h1>
			<p class="text-sm text-base-content/70">Recent agent conversations and orchestrator work</p>
		</div>
	{/snippet}

	{#if conversations.length === 0}
		<div class="flex flex-col items-center justify-center gap-4 py-20 text-center">
			<svg xmlns="http://www.w3.org/2000/svg" class="size-16 opacity-20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
				<path d="M1 12S5 4 12 4s11 8 11 8-4 8-11 8S1 12 1 12z"/>
				<circle cx="12" cy="12" r="3"/>
			</svg>
			<p class="text-lg font-medium text-base-content/60">No agent conversations yet</p>
			<p class="max-w-sm text-sm text-base-content/40">
				Agent work is reviewed inline in orchestrator conversations. Start a chat to delegate work to agents.
			</p>
			<a href="/" class="btn btn-primary btn-sm">Go to Chat</a>
		</div>
	{:else}
		<div class="space-y-2 p-4">
			{#each conversations as conv (conv.id)}
				<a
					href="/chat/{conv.id}"
					class="flex items-center gap-3 rounded-xl border border-base-300/50 px-4 py-3 transition-colors hover:bg-base-200"
				>
					<div class="min-w-0 flex-1">
						<div class="flex items-center gap-2">
							<span class="font-medium">{conv.title}</span>
							<span class="badge badge-ghost badge-xs">{agentName(conv.agentId)}</span>
						</div>
						{#if conv.lastMessage}
							<p class="mt-0.5 line-clamp-1 text-sm text-base-content/50">{conv.lastMessage}</p>
						{/if}
					</div>
					<span class="shrink-0 text-xs text-base-content/40">
						{new Date(conv.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
					</span>
				</a>
			{/each}
		</div>
	{/if}
</ContentPanel>
