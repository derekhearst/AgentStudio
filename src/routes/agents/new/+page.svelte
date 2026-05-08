<svelte:head><title>Create Agent | AgentStudio</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import { startGuidedCreationChat } from '$lib/chat/creation-flow';
	import PageHeader from '$lib/ui/PageHeader.svelte';

	onMount(() => {
		void startGuidedCreationChat({ kind: 'agent' });
	});
</script>

<div class="flex h-full min-h-0 flex-col">
	<PageHeader title="New agent" crumbs={[{ label: 'Agents', href: '/agents' }]} backHref="/agents" />
	<div class="min-h-0 flex-1 overflow-y-auto px-3 py-3 tablet:px-4 desktop:px-4 desktop:py-4">
		<section class="flex min-h-[40vh] items-center justify-center">
			<div class="text-center">
				<span class="loading loading-spinner loading-md text-primary"></span>
				<p class="mt-3 text-sm text-base-content/70">Opening guided agent creation chat...</p>
			</div>
		</section>
	</div>
</div>


