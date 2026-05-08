<svelte:head><title>Chat | AgentStudio</title></svelte:head>

<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';

	onMount(() => {
		void goto('/', { replaceState: true });
	});
</script>

<div class="flex h-full min-h-0 flex-col">
	<PageHeader title="Chat" />
	<div class="min-h-0 flex-1 overflow-y-auto px-3 py-3 tablet:px-4 desktop:px-4 desktop:py-4">
		<p class="text-sm text-base-content/70">Redirecting to chat...</p>
		<a class="link" href="/">Open chat</a>
	</div>
</div>
