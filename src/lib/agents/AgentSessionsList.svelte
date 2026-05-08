<script lang="ts">
	import type { getAgent } from '$lib/agents'
	import ContentPanel from '$lib/ui/ContentPanel.svelte'
	import { formatCost, formatDate, formatTokens, modelLeftBorder } from './agent-format'

	type AgentData = NonNullable<Awaited<ReturnType<typeof getAgent>>>
	type Conversation = AgentData['conversations'][number]

	let { conversations } = $props<{ conversations: Conversation[] }>()

	let showAll = $state(false)

	const visibleConversations = $derived(showAll ? conversations : conversations.slice(0, 10))
</script>

<ContentPanel>
	{#snippet header()}
		<div class="flex min-w-0 flex-1 items-center justify-between gap-2">
			<h2 class="font-semibold">Sessions</h2>
			<span class="badge badge-sm badge-ghost">{conversations.length}</span>
		</div>
	{/snippet}
	{#if conversations.length === 0}
		<p class="py-4 text-center text-sm text-base-content/40">No sessions yet.</p>
	{:else}
		<div class="space-y-2">
			{#each visibleConversations as chat (chat.id)}
				<a
					href="/chat/{chat.id}"
					class="flex items-center gap-3 rounded-xl border border-base-300/60 border-l-4 bg-base-200/20 p-3 transition-colors hover:bg-base-200/50 {modelLeftBorder(chat.model)}"
				>
					<div class="min-w-0 flex-1">
						<p class="truncate text-sm font-medium">{chat.title}</p>
						<div class="mt-0.5 flex items-center gap-2 text-xs text-base-content/50">
							<span>{formatDate(chat.updatedAt)}</span>
							{#if chat.messageCount > 0}
								<span>·</span>
								<span>{chat.messageCount} msgs</span>
							{/if}
						</div>
					</div>
					<div class="shrink-0 text-right text-xs text-base-content/50">
						<p class="tabular-nums">{formatTokens(chat.totalTokens)} tokens</p>
						<p class="tabular-nums">{formatCost(chat.totalCost)}</p>
					</div>
				</a>
			{/each}
		</div>

		{#if conversations.length > 10}
			<div class="mt-3 text-center">
				<button class="btn btn-sm btn-ghost" onclick={() => (showAll = !showAll)}>
					{showAll ? 'Show fewer' : `Show all ${conversations.length} sessions`}
				</button>
			</div>
		{/if}
	{/if}
</ContentPanel>
