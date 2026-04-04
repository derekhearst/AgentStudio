<svelte:head><title>Chat | DrokBot</title></svelte:head>

<script lang="ts">
	import { goto } from '$app/navigation';
	import { createConversation, getConversations } from '$lib/chat/chat.remote';

	let busy = $state(false);
	let prompt = $state('');

	function getGreeting() {
		const hour = new Date().getHours();
		if (hour < 12) return 'Good morning';
		if (hour < 18) return 'Good afternoon';
		return 'Good evening';
	}

	const greeting = getGreeting();

	async function handleNewChat(initialPrompt?: string) {
		if (busy) return;
		busy = true;
		try {
			const title = initialPrompt?.slice(0, 80) || 'New conversation';
			const created = await createConversation({ title });
			await goto(`/chat/${created.id}`);
		} finally {
			busy = false;
		}
	}

	function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		const trimmed = prompt.trim();
		if (!trimmed) return;
		void handleNewChat(trimmed);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			const trimmed = prompt.trim();
			if (trimmed) void handleNewChat(trimmed);
		}
	}

	const suggestions = [
		{ label: 'Write code', icon: '✦', prompt: 'Help me write ' },
		{ label: 'Debug an issue', icon: '⚡', prompt: 'Help me debug ' },
		{ label: 'Explain a concept', icon: '📖', prompt: 'Explain ' },
		{ label: 'Brainstorm ideas', icon: '💡', prompt: 'Brainstorm ideas for ' }
	];
</script>

<div class="flex flex-1 flex-col items-center justify-center">
	<div class="w-full max-w-2xl space-y-8 text-center">
		<!-- Greeting -->
		<div>
			<h1 class="text-4xl font-semibold tracking-tight text-base-content/90">{greeting}, Derek</h1>
			<p class="mt-2 text-lg text-base-content/50">How can I help you today?</p>
		</div>

		<!-- Input Area -->
		<form onsubmit={handleSubmit} class="relative">
			<textarea
				class="textarea w-full resize-none rounded-2xl border border-base-300 bg-base-100 px-5 py-4 pr-14 text-base shadow-sm transition-shadow focus:shadow-md focus:outline-none"
				rows="3"
				placeholder="Start a new conversation..."
				bind:value={prompt}
				onkeydown={handleKeydown}
				disabled={busy}
			></textarea>
			<button
				type="submit"
				class="btn btn-circle btn-primary btn-sm absolute bottom-3 right-3"
				disabled={busy || prompt.trim().length === 0}
				aria-label="Send"
			>
				{#if busy}
					<span class="loading loading-spinner loading-xs"></span>
				{:else}
					↑
				{/if}
			</button>
		</form>

		<!-- Suggestion Chips -->
		<div class="flex flex-wrap justify-center gap-2">
			{#each suggestions as s (s.label)}
				<button
					type="button"
					class="btn btn-sm btn-outline rounded-full"
					disabled={busy}
					onclick={() => { prompt = s.prompt; }}
				>
					<span>{s.icon}</span>
					{s.label}
				</button>
			{/each}
		</div>
	</div>
</div>
