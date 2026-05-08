<svelte:head><title>Research | AgentStudio</title></svelte:head>

<script lang="ts">
	import { page } from '$app/state';
	import ResearchArtifactView from '$lib/artifacts/ResearchArtifactView.svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';

	const researchId = $derived(page.params.id ?? '');
</script>

<div class="flex h-full min-h-0 flex-col">
	<PageHeader
		title="Research"
		crumbs={[{ label: 'Artifacts', href: '/artifacts' }]}
		backHref="/artifacts"
	/>

	<div class="min-h-0 flex-1 overflow-y-auto px-3 py-3 tablet:px-4 desktop:px-4 desktop:py-4">
		<div class="card overflow-hidden border border-base-300/60 bg-base-100 tablet:rounded-3xl">
			<div class="h-[calc(100vh-12rem)] min-h-[400px]">
				<ResearchArtifactView id={researchId} />
			</div>
		</div>
	</div>
</div>
