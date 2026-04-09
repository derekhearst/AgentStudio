<svelte:head><title>Skills | AgentStudio</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import { listSkillsQuery } from '$lib/skills';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';

	type SkillRow = Awaited<ReturnType<typeof listSkillsQuery>>[number];

	let search = $state('');
	let skills = $state<SkillRow[]>([]);
	let allSkills = $state<SkillRow[]>([]);

	let filterTimer: ReturnType<typeof setTimeout> | undefined;

	onMount(() => {
		void loadSkills();
	});

	async function loadSkills() {
		allSkills = await listSkillsQuery({ limit: 200 });
		filterLocally();
	}

	function filterLocally() {
		const q = search.trim().toLowerCase();

		let filtered = allSkills;
		filtered = filtered.filter((s) => !s.name.startsWith('capability:'));

		// Filter by search text
		if (q) {
			filtered = filtered.filter(
				(s) =>
					s.name.toLowerCase().includes(q) ||
					s.description.toLowerCase().includes(q) ||
					s.tags.some((t) => t.toLowerCase().includes(q))
			);
		}

		skills = filtered;
	}

	function handleSearchInput() {
		clearTimeout(filterTimer);
		filterTimer = setTimeout(filterLocally, 150);
	}
</script>

<div class="flex h-full min-h-0 flex-col space-y-3 sm:space-y-4">
	<ContentPanel>
		{#snippet header()}
			<div>
				<h1 class="text-xl font-bold sm:text-3xl">Skills</h1>
				<p class="text-xs text-base-content/70 sm:text-sm">
					{skills.length} {skills.length === 1 ? 'skill' : 'skills'} - Reusable instruction bundles for the LLM
				</p>
			</div>
		{/snippet}
	</ContentPanel>

	<!-- Search -->
	<div class="flex shrink-0 items-center gap-2">
		<input
			class="input input-bordered input-md flex-1"
			bind:value={search}
			oninput={handleSearchInput}
			placeholder="Search skills..."
		/>
	</div>

	<!-- Skill list (scrollable) -->
	<div class="min-h-0 flex-1 overflow-y-auto rounded-xl bg-base-200/40 px-3 sm:px-4">
	{#if skills.length === 0}
		<div class="flex flex-col items-center gap-2 py-16 opacity-50">
			<svg xmlns="http://www.w3.org/2000/svg" class="size-12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
				<path d="M22 10v6M2 10l10-5 10 5-10 5z"/>
				<path d="M6 12v5c0 1.66 2.69 3 6 3s6-1.34 6-3v-5"/>
			</svg>
			<p class="text-sm">No skills yet. Start a guided creation chat to create one.</p>
		</div>
	{:else}
		<div class="space-y-2">
			{#each skills as skill (skill.id)}
				<a href="/skills/{skill.id}" class="block rounded-xl border border-base-300 bg-base-100 p-4 transition-colors hover:border-base-content/20">
					<div class="flex items-center gap-2">
						<h3 class="font-semibold">{skill.name}</h3>
						{#if skill.isSystem}
							<span class="badge badge-primary badge-xs">built-in</span>
						{/if}
						{#if !skill.enabled}
							<span class="badge badge-ghost badge-xs">disabled</span>
						{/if}
					</div>
					<p class="mt-0.5 text-sm opacity-60">{skill.description}</p>
					<div class="mt-2 flex flex-wrap items-center gap-2 text-xs opacity-50">
						{#if skill.tags.length > 0}
							{#each skill.tags as tag (tag)}
								<span class="badge badge-outline badge-xs">{tag}</span>
							{/each}
						{/if}
						<span>{skill.fileCount} file{skill.fileCount !== 1 ? 's' : ''}</span>
						<span>&middot;</span>
						<span>{skill.accessCount} reads</span>
					</div>
				</a>
			{/each}
		</div>
	{/if}
	</div>
</div>

