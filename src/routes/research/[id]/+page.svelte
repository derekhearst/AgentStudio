<svelte:head><title>Research | AgentStudio</title></svelte:head>

<script lang="ts">
	import { page } from '$app/state';
	import { getResearchDetailQuery } from '$lib/research/research.remote';
	import ResearchReportView from '$lib/research/ResearchReportView.svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';

	const researchId = $derived(page.params.id ?? '');

	/*
	 * #14 — a run started from a chat goes back to that chat. The chat's rail used to list its
	 * research runs; with that tab gone this is the link between the two. Read with
	 * `.current` so the header never waits on it: until it arrives, Back goes to /research.
	 */
	const detailQuery = $derived(researchId ? getResearchDetailQuery(researchId) : null);
	const chatId = $derived(detailQuery?.current?.research.conversationId ?? null);
</script>

<div class="flex h-full min-h-0 flex-col">
	<PageHeader
		title="Research"
		crumbs={chatId
			? [{ label: 'Chat', href: `/chat/${chatId}` }, { label: 'Research', href: '/research' }]
			: [{ label: 'Research', href: '/research' }]}
		backHref={chatId ? `/chat/${chatId}` : '/research'}
	/>

	<div class="min-h-0 flex-1 overflow-y-auto px-3 py-3 tablet:px-4 desktop:px-4 desktop:py-4">
		<div class="card overflow-hidden border border-base-300/60 bg-base-100 tablet:rounded-3xl">
			<div class="h-[calc(100vh-12rem)] min-h-[400px]">
				<ResearchReportView id={researchId} />
			</div>
		</div>
	</div>
</div>
