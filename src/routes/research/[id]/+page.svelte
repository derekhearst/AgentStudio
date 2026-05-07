<svelte:head><title>Research | AgentStudio</title></svelte:head>

<script lang="ts">
	import { page } from '$app/state';
	import ResearchArtifactView from '$lib/artifacts/ResearchArtifactView.svelte';

	const researchId = $derived(page.params.id ?? '');
</script>

<section class="space-y-3 sm:space-y-4">
	<a class="btn btn-sm btn-ghost -ml-1 w-fit" href="/artifacts">← All artifacts</a>

	<div class="card overflow-hidden border border-base-300/60 bg-base-100 tablet:rounded-3xl">
		<div class="h-[calc(100vh-8rem)] min-h-[400px]">
			<ResearchArtifactView id={researchId} />
		</div>
	</div>
</section>
