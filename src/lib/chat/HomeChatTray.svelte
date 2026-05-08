<script lang="ts">
	import { fade, fly, scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import type { getConversations, listAgentsForPicker } from '$lib/chat/chat.remote';

	type Conversation = Awaited<ReturnType<typeof getConversations>>[number];
	type AgentChoice = Awaited<ReturnType<typeof listAgentsForPicker>>[number];
	type LiveRun = {
		id: string;
		conversationId: string;
		state: 'queued' | 'running' | 'waiting_tool_approval' | 'waiting_user_input';
		label?: string | null;
		lastHeartbeatAt?: string | Date | null;
		updatedAt?: string | Date | null;
	};
	type Group = { label: string; items: Conversation[] };

	let {
		grouped,
		filtered,
		agentChoices,
		searchQuery = $bindable(),
		groupMode = $bindable(),
		agentFilter = $bindable(),
		runForConversation,
		runLabel,
		onClose,
	}: {
		grouped: Group[];
		filtered: Conversation[];
		agentChoices: AgentChoice[];
		searchQuery: string;
		groupMode: 'date' | 'category';
		agentFilter: 'all' | 'orchestrator' | string;
		runForConversation: (c: Conversation) => LiveRun | null;
		runLabel: (run: LiveRun) => string;
		onClose: () => void;
	} = $props();

	// Mobile bottom-sheet drag-to-dismiss state.
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
			onClose();
		}
		trayDragY = 0;
		trayDragging = false;
	}
</script>

{#snippet ChatGroups()}
	{#if filtered.length === 0}
		<p class="py-6 text-center text-sm text-base-content/40">
			{searchQuery ? 'No matches' : 'No conversations yet'}
		</p>
	{:else}
		{#each grouped as group (group.label)}
			<div>
				<p class="mb-2 text-xs font-semibold uppercase tracking-wider text-base-content/50">{group.label}</p>
				<div class="space-y-0.5">
					{#each group.items as chat (chat.id)}
						{@const run = runForConversation(chat)}
						<a
							href={`/chat/${chat.id}`}
							class="chat-list-item block rounded-xl px-2.5 py-2 text-sm transition-colors hover:bg-base-200"
						>
							<span class="line-clamp-1 font-medium">
								{#if run}
									<span class="mr-1.5 inline-flex h-2.5 w-2.5 rounded-full {run.state === 'running' || run.state === 'queued' ? 'animate-pulse bg-info' : 'bg-warning'}"></span>
								{/if}
								{chat.title}
							</span>
							<span class="mt-0.5 line-clamp-1 text-xs text-base-content/50">
								{run ? runLabel(run) : (chat.lastMessage ?? 'No messages yet')}
							</span>
						</a>
					{/each}
				</div>
			</div>
		{/each}
	{/if}
{/snippet}

<!-- Scrim -->
<button
	type="button"
	class="bottom-sheet-scrim fixed inset-0 z-10"
	onclick={onClose}
	aria-label="Close chat list"
	transition:fade={{ duration: 200 }}
></button>

<!-- Mobile tray (bottom sheet with drag-to-dismiss) -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="bottom-sheet fixed inset-x-0 bottom-0 z-20 flex max-h-[80vh] flex-col rounded-t-2xl border-t border-base-300 bg-base-100/95 pb-14 shadow-2xl backdrop-blur-xl tablet:rounded-t-3xl desktop:pb-0 tablet:hidden"
	style="transform: translateY({trayDragging && trayDragY > 0 ? trayDragY + 'px' : '0'}); transition: {trayDragging ? 'none' : 'transform 200ms ease-out'};"
	transition:fly={{ y: 400, duration: 380, easing: cubicOut }}
	ontouchstart={onTrayTouchStart}
	ontouchmove={onTrayTouchMove}
	ontouchend={onTrayTouchEnd}
>
	<div class="flex shrink-0 justify-center pb-1 pt-3">
		<div class="h-1 w-10 rounded-full bg-base-content/20"></div>
	</div>

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

		<div class="flex gap-2">
			<input
				type="text"
				class="input input-bordered input-sm min-w-0 flex-1"
				placeholder="Search chats…"
				bind:value={searchQuery}
				aria-label="Search chats"
			/>
			<select
				class="select select-bordered select-sm w-auto max-w-35"
				bind:value={agentFilter}
				aria-label="Filter by agent"
			>
				<option value="all">All</option>
				<option value="orchestrator">Orchestrator</option>
				{#each agentChoices as agent (agent.id)}
					<option value={agent.id}>{agent.name}</option>
				{/each}
			</select>
		</div>
	</div>

	<div bind:this={trayScrollEl} class="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-none px-4 pb-6">
		{@render ChatGroups()}
	</div>
</div>

<!-- Tablet modal panel -->
<div class="fixed inset-0 z-20 hidden px-5 py-8 tablet:flex desktop:hidden" transition:fade={{ duration: 180 }}>
	<div class="mx-auto flex h-full w-full max-w-4xl items-stretch">
		<div
			class="flex w-full min-h-0 flex-col overflow-hidden card card-body bg-base-100/95 border-base-300 rounded-3xl border shadow-2xl backdrop-blur-xl"
			transition:scale={{ duration: 220, start: 0.96, easing: cubicOut }}
		>
			<div class="shrink-0 border-b border-base-300/70 px-6 py-5">
				<div class="flex items-center gap-4">
					<div class="min-w-0 flex-1">
						<p class="text-xs font-semibold uppercase tracking-[0.14em] text-base-content/45">Conversation browser</p>
						<h2 class="mt-1 text-2xl font-semibold tracking-tight">All chats</h2>
					</div>
					<span class="badge badge-outline badge-lg">{filtered.length}</span>
					<button type="button" class="btn btn-ghost btn-sm" onclick={onClose} aria-label="Close chat list">Close</button>
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
						bind:value={searchQuery}
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
