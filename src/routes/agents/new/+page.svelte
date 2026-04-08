<svelte:head><title>Create Agent | AgentStudio</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import { startGuidedCreationChat } from '$lib/chat/creation-flow';

	onMount(() => {
		void startGuidedCreationChat({ kind: 'agent' });
	});
</script>

<section class="flex min-h-[40vh] items-center justify-center">
	<div class="text-center">
		<span class="loading loading-spinner loading-md text-primary"></span>
		<p class="mt-3 text-sm text-base-content/70">Opening guided agent creation chat...</p>
	</div>
</section>


