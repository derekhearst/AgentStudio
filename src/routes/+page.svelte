<svelte:head><title>Chat | AgentStudio</title></svelte:head>

<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { createConversation, getConversations, listAgentsForPicker, getWorkbenchPreferences } from '$lib/chat/chat.remote';
	import { getSettings } from '$lib/settings';
	import ChatInput from '$lib/chat/ChatInput.svelte';
	import HomeChatTray from '$lib/chat/HomeChatTray.svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import { loadReasoningEffort, saveReasoningEffort, type ReasoningEffort } from '$lib/chat/reasoning-effort';

	let busy = $state(false);
	let prompt = $state('');
	let model = $state('anthropic/claude-sonnet-4');
	let agentId = $state<string | null>(null);
	let reasoningEffort = $state<ReasoningEffort>('none');
	let reasoningHydrated = $state(false);
	let modelInitialized = $state(false);
	let expanded = $state(false);
	let search = $state('');
	let groupMode = $state<'date' | 'category'>('date');
	let agentFilter = $state<'all' | 'orchestrator' | string>('all');

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
	let recentChats = $state<Conversation[]>([]);
	let agentChoices = $state<AgentChoice[]>([]);
	let liveRuns = $state<Record<string, LiveRun>>({});

	$effect(() => {
		void loadRecent();
	});

	$effect(() => {
		if (modelInitialized) return;
		void loadDefaultModel();
	});

	$effect(() => {
		if (!browser || reasoningHydrated) return;
		const stored = loadReasoningEffort();
		if (stored) reasoningEffort = stored;
		reasoningHydrated = true;
	});

	$effect(() => {
		if (!browser || !reasoningHydrated) return;
		saveReasoningEffort(reasoningEffort);
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
		agentChoices = await listAgentsForPicker();
		// Pick the user's default agent (or the first built-in) once choices land.
		if (agentId == null && agentChoices.length > 0) {
			try {
				const prefs = await getWorkbenchPreferences();
				agentId =
					(prefs.defaultAgentId && agentChoices.some((a) => a.id === prefs.defaultAgentId)
						? prefs.defaultAgentId
						: agentChoices.find((a) => a.builtinKey === 'chat')?.id ?? agentChoices[0]?.id) ?? null;
			} catch {
				agentId = agentChoices.find((a) => a.builtinKey === 'chat')?.id ?? agentChoices[0]?.id ?? null;
			}
		}
	}

	function runForConversation(conversation: Conversation): LiveRun | null {
		return liveRuns[conversation.id] ?? conversation.activeRun ?? null;
	}

	function runLabel(run: LiveRun) {
		if (run.label && run.label.trim().length > 0) return run.label;
		switch (run.state) {
			case 'queued':
				return 'Queued';
			case 'running':
				return 'Running';
			case 'waiting_tool_approval':
				return 'Needs approval';
			case 'waiting_user_input':
				return 'Waiting for you';
			default:
				return 'Running';
		}
	}

	onMount(() => {
		if (!browser) return;
		const source = new EventSource('/api/chat/monitor');
		source.onmessage = (event) => {
			try {
				const runs = JSON.parse(event.data) as LiveRun[];
				const next: Record<string, LiveRun> = {};
				for (const run of runs) {
					next[run.conversationId] = run;
				}
				liveRuns = next;
			} catch {
				// Ignore malformed monitor payloads.
			}
		};

		return () => {
			source.close();
		};
	});

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
		let results = sorted;

		// Agent filter
		if (agentFilter === 'orchestrator') {
			results = results.filter((c) => !c.agentId);
		} else if (agentFilter !== 'all') {
			results = results.filter((c) => c.agentId === agentFilter);
		}

		if (!q) return results;
		return results.filter(
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
			const created = await createConversation({ title, model, agentId: agentId ?? undefined });
			if (trimmedPrompt) {
				await goto(`/chat/${created.id}?prompt=${encodeURIComponent(trimmedPrompt)}`);
			} else {
				await goto(`/chat/${created.id}`);
			}
		} finally {
			busy = false;
		}
	}

	async function handleComposerSubmit(content: string) {
		// All agents — including Research — go through handleNewChat. The Research agent
		// drafts a plan as a markdown artifact, surfaces it via present_artifact, and hands
		// off via request_plan_approval to a research-runner agent on approval.
		await handleNewChat(content);
	}
</script>

<div class="relative flex min-h-0 flex-1 flex-col overflow-hidden">
<PageHeader title="New chat" subtitle={greeting} />
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
			<ChatInput
				bind:value={prompt}
				{busy}
				{model}
				{agentId}
				{agentChoices}
				reasoningEffort={reasoningEffort}
				placeholder="Start a new conversation..."
				onSubmit={(content) => handleComposerSubmit(content)}
				onModelChange={(id) => {
					model = id;
				}}
				onReasoningEffortChange={(next) => {
					reasoningEffort = next;
				}}
				onAgentChange={(next) => {
					agentId = next;
				}}
			/>
		</div>

		<!-- Recent chats (visible when sidebar is hidden) -->
		{#if recentChats.length > 0}
			<div class="w-full space-y-2 text-left desktop:hidden">
				<h2 class="text-xs font-semibold uppercase tracking-wide text-base-content/40">Recent chats</h2>
				<div class="space-y-0.5">
					{#each recentChats.slice(0, 5) as chat (chat.id)}
						{@const run = runForConversation(chat)}
						<a
							href={`/chat/${chat.id}`}
							class="flex items-baseline gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-base-200"
						>
							<span class="min-w-0 flex-1 truncate font-medium">
								{#if run}
									<span class="mr-1.5 inline-flex h-2.5 w-2.5 rounded-full {run.state === 'running' || run.state === 'queued' ? 'animate-pulse bg-info' : 'bg-warning'}"></span>
								{/if}
								{chat.title}
							</span>
							<span class="shrink-0 text-[11px] text-base-content/40">
								{run ? runLabel(run) : new Date(chat.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
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

{#if expanded}
	<HomeChatTray
		{grouped}
		{filtered}
		{agentChoices}
		bind:searchQuery={search}
		bind:groupMode
		bind:agentFilter
		{runForConversation}
		{runLabel}
		onClose={closeChatList}
	/>
{/if}
</div>

