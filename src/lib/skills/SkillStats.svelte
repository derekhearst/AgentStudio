<script lang="ts">
	import { listSkillsQuery } from '$lib/skills';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';

	type SkillRow = Awaited<ReturnType<typeof listSkillsQuery>>[number];

	let skills = $state<SkillRow[]>([]);

	$effect(() => {
		void loadSkills();
	});

	async function loadSkills() {
		skills = await listSkillsQuery({ limit: 200 });
	}

	const totalSkills = $derived(skills.length);
	const enabledCount = $derived(skills.filter((s) => s.enabled).length);
	const disabledCount = $derived(skills.filter((s) => !s.enabled).length);
	const totalReads = $derived(skills.reduce((sum, s) => sum + s.accessCount, 0));
	const totalFiles = $derived(skills.reduce((sum, s) => sum + s.fileCount, 0));
	const avgReads = $derived(totalSkills > 0 ? Math.round(totalReads / totalSkills) : 0);

	const topByAccess = $derived(
		[...skills]
			.sort((a, b) => b.accessCount - a.accessCount)
			.slice(0, 5)
	);

	const recentlyAccessed = $derived(
		[...skills]
			.filter((s) => s.lastAccessed)
			.sort((a, b) => new Date(b.lastAccessed!).getTime() - new Date(a.lastAccessed!).getTime())
			.slice(0, 5)
	);

	const tagCounts = $derived.by(() => {
		const map = new Map<string, number>();
		for (const s of skills) {
			for (const t of s.tags) {
				map.set(t, (map.get(t) ?? 0) + 1);
			}
		}
		return [...map.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 10);
	});

	function relativeTime(date: Date | string) {
		const diff = Date.now() - new Date(date).getTime();
		const minutes = Math.floor(diff / 60_000);
		if (minutes < 1) return 'just now';
		if (minutes < 60) return `${minutes}m ago`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}h ago`;
		const days = Math.floor(hours / 24);
		return `${days}d ago`;
	}
</script>

<ContentPanel bare compact flush>
	{#snippet header()}
		<div class="w-full pb-3">
			<h1 class="text-xl font-bold sm:text-3xl">Skill Stats</h1>
			<p class="text-xs text-base-content/70 sm:text-sm">Usage overview</p>
		</div>
	{/snippet}

	<!-- Summary stats -->
	<div class="grid grid-cols-2 gap-2">
		<div class="rounded-lg bg-base-200/60 px-3 py-2 text-center">
			<p class="text-lg font-bold">{totalSkills}</p>
			<p class="text-[11px] text-base-content/50">Total Skills</p>
		</div>
		<div class="rounded-lg bg-base-200/60 px-3 py-2 text-center">
			<p class="text-lg font-bold">{enabledCount}</p>
			<p class="text-[11px] text-base-content/50">Enabled</p>
		</div>
		<div class="rounded-lg bg-base-200/60 px-3 py-2 text-center">
			<p class="text-lg font-bold">{totalReads}</p>
			<p class="text-[11px] text-base-content/50">Total Reads</p>
		</div>
		<div class="rounded-lg bg-base-200/60 px-3 py-2 text-center">
			<p class="text-lg font-bold">{totalFiles}</p>
			<p class="text-[11px] text-base-content/50">Total Files</p>
		</div>
	</div>

	<!-- Most accessed skills -->
	{#if topByAccess.length > 0}
		<div class="mt-4">
			<p class="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-base-content/40">Most Accessed</p>
			<div class="space-y-1">
				{#each topByAccess as skill (skill.id)}
					<a
						href={`/skills/${skill.id}`}
						class="flex items-center justify-between rounded-xl px-2.5 py-2 text-sm transition-colors hover:bg-base-200"
					>
						<div class="min-w-0 flex-1">
							<span class="line-clamp-1 font-medium">{skill.name}</span>
						</div>
						<div class="flex shrink-0 items-center gap-2">
							<span class="text-xs text-base-content/50">{skill.accessCount} reads</span>
							{#if !skill.enabled}
								<span class="badge badge-ghost badge-xs">off</span>
							{/if}
						</div>
					</a>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Recently accessed -->
	{#if recentlyAccessed.length > 0}
		<div class="mt-4">
			<p class="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-base-content/40">Recently Used</p>
			<div class="space-y-1">
				{#each recentlyAccessed as skill (skill.id)}
					<a
						href={`/skills/${skill.id}`}
						class="flex items-center justify-between rounded-xl px-2.5 py-2 text-sm transition-colors hover:bg-base-200"
					>
						<span class="line-clamp-1 min-w-0 flex-1 font-medium">{skill.name}</span>
						<span class="shrink-0 text-xs text-base-content/50">{relativeTime(skill.lastAccessed!)}</span>
					</a>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Tag distribution -->
	{#if tagCounts.length > 0}
		<div class="mt-4">
			<p class="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-base-content/40">Tags</p>
			<div class="flex flex-wrap gap-1.5">
				{#each tagCounts as [tag, count]}
					<span class="badge badge-outline badge-sm gap-1">
						{tag}
						<span class="text-base-content/40">{count}</span>
					</span>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Disabled skills -->
	{#if disabledCount > 0}
		<div class="mt-4">
			<p class="mb-1 text-[11px] font-medium uppercase tracking-wide text-base-content/40">Disabled</p>
			<p class="text-xs text-base-content/50">
				{disabledCount} skill{disabledCount !== 1 ? 's' : ''} currently disabled
			</p>
		</div>
	{/if}
</ContentPanel>

