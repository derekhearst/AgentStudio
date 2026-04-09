<svelte:head><title>{data?.agent.name ?? 'Agent'} | AgentStudio</title></svelte:head>

<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { getAgent } from '$lib/agents';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';

	const agentId = $derived(page.params.id ?? '');
	let data = $state<Awaited<ReturnType<typeof getAgent>> | null>(null);

	onMount(() => {
		void refresh();
	});

	async function refresh() {
		if (!agentId) return;
		data = await getAgent(agentId);
	}
</script>

{#if !data}
	<p class="text-sm text-base-content/70">Agent not found.</p>
{:else}
	<section class="space-y-4">
		<a class="btn btn-sm btn-ghost" href="/agents">Back to agents</a>
		<ContentPanel>
			{#snippet header()}
				<div>
					<h1 class="text-2xl font-bold">{data?.agent.name}</h1>
					<p class="text-sm text-base-content/70">{data?.agent.role}</p>
					<p class="mt-2 text-xs text-base-content/70">Status: {data?.agent.status}</p>
				</div>
			{/snippet}
		</ContentPanel>

		<ContentPanel>
			{#snippet header()}<h2 class="font-semibold">Conversations</h2>{/snippet}
			<div class="space-y-2">
				{#if data.conversations.length === 0}
					<p class="text-sm text-base-content/70">No conversations yet.</p>
				{:else}
					{#each data.conversations as chat (chat.id)}
						<a
							href="/chat/{chat.id}"
							class="flex items-center justify-between rounded-xl border border-base-300 p-3 text-sm hover:bg-base-200/50"
						>
							<div class="min-w-0 flex-1">
								<p class="truncate font-medium">{chat.title}</p>
								<p class="text-xs text-base-content/70">
									{new Date(chat.updatedAt).toLocaleString()}
								</p>
							</div>
							<div class="text-right text-xs text-base-content/60">
								<p>{chat.totalTokens.toLocaleString()} tokens</p>
								<p>${Number(chat.totalCost).toFixed(4)}</p>
							</div>
						</a>
					{/each}
				{/if}
			</div>
		</ContentPanel>
	</section>
{/if}

