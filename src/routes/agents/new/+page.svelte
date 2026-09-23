<svelte:head><title>Create Agent | AgentStudio</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import { startGuidedCreationChat } from '$lib/chat/creation-flow';
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import { remoteErrorMessage } from '$lib/ui/remote-error';

	let error = $state<string | null>(null);

	// This route only opens the guided chat, so it replaces its own history entry: Back
	// from the chat goes to wherever you came from, not here to start another run.
	onMount(() => {
		startGuidedCreationChat({ kind: 'agent' }, { replaceState: true }).catch((err) => {
			error = remoteErrorMessage(err, 'Could not start the guided creation chat.');
		});
	});
</script>

<div class="flex h-full min-h-0 flex-col">
	<PageHeader title="New agent" crumbs={[{ label: 'Agents', href: '/agents' }]} backHref="/agents" />
	<div class="min-h-0 flex-1 overflow-y-auto px-3 py-3 tablet:px-4 desktop:px-4 desktop:py-4">
		<section class="flex min-h-[40vh] items-center justify-center">
			<div class="text-center">
				{#if error}
					<p role="alert" class="text-sm text-error">{error}</p>
					<a class="btn btn-ghost btn-sm mt-4" href="/agents">← Back to agents</a>
				{:else}
					<span class="loading loading-spinner loading-md text-primary"></span>
					<p class="mt-3 text-sm text-base-content/70">Opening guided agent creation chat...</p>
				{/if}
			</div>
		</section>
	</div>
</div>
