<svelte:head><title>Projects | AgentStudio</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte'
	import ContentPanel from '$lib/ui/ContentPanel.svelte'
	import {
		listProjectGoalsQuery,
		listProjectStrategiesQuery,
		listProjectsQuery,
		setProjectStatusCommand,
	} from '$lib/projects'
	import { startGuidedCreationChat } from '$lib/chat/creation-flow'

	type ProjectRow = Awaited<ReturnType<typeof listProjectsQuery>>[number]
	type GoalRow = Awaited<ReturnType<typeof listProjectGoalsQuery>>[number]
	type StrategyRow = Awaited<ReturnType<typeof listProjectStrategiesQuery>>[number]

	let projects = $state<ProjectRow[]>([])
	let selectedProjectId = $state<string | null>(null)
	let selectedGoals = $state<GoalRow[]>([])
	let selectedStrategies = $state<StrategyRow[]>([])
	let loading = $state(true)
	let archiving = $state(false)

	onMount(() => {
		void refresh()
	})

	async function refresh() {
		loading = true
		projects = await listProjectsQuery({ includeArchived: true })
		if (!selectedProjectId || !projects.some((project) => project.id === selectedProjectId)) {
			selectedProjectId = projects[0]?.id ?? null
		}
		await loadSelectedProjectDetails()
		loading = false
	}

	async function loadSelectedProjectDetails() {
		if (!selectedProjectId) {
			selectedGoals = []
			selectedStrategies = []
			return
		}

		const [goals, strategies] = await Promise.all([
			listProjectGoalsQuery({ projectId: selectedProjectId }),
			listProjectStrategiesQuery({ projectId: selectedProjectId }),
		])

		selectedGoals = goals
		selectedStrategies = strategies
	}

	async function archiveSelectedProject() {
		if (!selectedProjectId || archiving) return
		archiving = true
		try {
			await setProjectStatusCommand({ projectId: selectedProjectId, status: 'archived' })
			await refresh()
		} finally {
			archiving = false
		}
	}

	async function activateProject(projectId: string) {
		await setProjectStatusCommand({ projectId, status: 'active' })
		await refresh()
	}

	const selectedProject = $derived(projects.find((project) => project.id === selectedProjectId) ?? null)
</script>

<div class="space-y-4">
	<ContentPanel>
		{#snippet header()}
			<div>
				<h1 class="text-3xl font-bold">Projects</h1>
				<p class="text-sm text-base-content/70">
					Unified workspace for goals, agents, tasks, and strategy approvals.
				</p>
			</div>
		{/snippet}

		<div class="grid gap-3 lg:grid-cols-[1.4fr_1fr]">
			<section class="rounded-2xl border border-base-300 bg-base-200/40 p-3">
				<p class="text-xs font-semibold uppercase tracking-wide text-base-content/60">Create project</p>
				<p class="mt-2 text-sm text-base-content/70">
					Start a cooperative planning session in chat. The assistant will ask questions and prepare an approval plan before execution.
				</p>
				<div class="mt-3 flex justify-end">
					<button class="btn btn-primary btn-sm" type="button" onclick={() => startGuidedCreationChat({ kind: 'project' })}>
						Create Project in Chat
					</button>
				</div>
			</section>

			<div class="rounded-2xl border border-base-300 bg-base-200/40 p-3">
				<p class="text-xs font-semibold uppercase tracking-wide text-base-content/60">V1 scope now</p>
				<ul class="mt-2 list-disc space-y-1 pl-5 text-sm text-base-content/80">
					<li>Project ownership and lifecycle</li>
					<li>Goal hierarchy for context propagation</li>
					<li>Strategy submit and board approval APIs</li>
					<li>Project-scoped task/agent schema hooks</li>
				</ul>
			</div>
		</div>
	</ContentPanel>

	{#if loading}
		<div class="flex justify-center p-8"><span class="loading loading-spinner loading-lg"></span></div>
	{:else}
		<div class="grid gap-4 xl:grid-cols-[340px_1fr]">
			<section class="rounded-2xl border border-base-300 bg-base-100 p-3">
				<div class="mb-2 flex items-center justify-between">
					<h2 class="text-sm font-semibold">Your Projects</h2>
					<span class="badge badge-ghost badge-sm">{projects.length}</span>
				</div>
				{#if projects.length === 0}
					<p class="text-sm text-base-content/60">No projects yet. Start a guided creation chat above.</p>
				{:else}
					<div class="space-y-2">
						{#each projects as project (project.id)}
							<button
								type="button"
								class="w-full rounded-xl border p-3 text-left transition hover:border-base-content/30 {selectedProjectId === project.id
									? 'border-primary/50 bg-primary/10'
									: 'border-base-300 bg-base-200/40'}"
								onclick={async () => {
									selectedProjectId = project.id
									await loadSelectedProjectDetails()
								}}
							>
								<div class="flex items-start justify-between gap-2">
									<div>
										<p class="font-medium">{project.name}</p>
										{#if project.description}
											<p class="mt-0.5 text-xs text-base-content/65">{project.description}</p>
										{/if}
									</div>
									<span class="badge badge-sm {project.status === 'active' ? 'badge-success' : 'badge-ghost'}">{project.status}</span>
								</div>
							</button>
						{/each}
					</div>
				{/if}
			</section>

			<section class="rounded-2xl border border-base-300 bg-base-100 p-4">
				{#if !selectedProject}
					<p class="text-sm text-base-content/60">Select a project to inspect goals and strategy queue.</p>
				{:else}
					<div class="mb-4 flex items-start justify-between gap-3">
						<div>
							<h2 class="text-xl font-semibold">{selectedProject.name}</h2>
							<p class="text-sm text-base-content/65">
								{selectedProject.description || 'No description provided yet.'}
							</p>
						</div>
						<div class="flex gap-2">
							{#if selectedProject.status === 'archived'}
								<button class="btn btn-outline btn-sm" onclick={() => activateProject(selectedProject.id)}>
									Reactivate
								</button>
							{:else}
								<button class="btn btn-outline btn-sm" onclick={archiveSelectedProject} disabled={archiving}>
									{archiving ? 'Archiving...' : 'Archive'}
								</button>
							{/if}
						</div>
					</div>

					<div class="grid gap-3 lg:grid-cols-2">
						<div class="rounded-xl border border-base-300 bg-base-200/40 p-3">
							<div class="mb-2 flex items-center justify-between">
								<h3 class="text-sm font-semibold">Goals</h3>
								<span class="badge badge-ghost badge-sm">{selectedGoals.length}</span>
							</div>
							<ul class="space-y-1 text-sm">
								{#if selectedGoals.length === 0}
									<li class="text-base-content/60">No goals yet.</li>
								{:else}
									{#each selectedGoals as goal (goal.id)}
										<li class="flex items-center justify-between gap-2 rounded-lg bg-base-100 px-2 py-1.5">
											<span class="truncate">{goal.title}</span>
											<span class="badge badge-xs">{goal.status}</span>
										</li>
									{/each}
								{/if}
							</ul>
						</div>

						<div class="rounded-xl border border-base-300 bg-base-200/40 p-3">
							<div class="mb-2 flex items-center justify-between">
								<h3 class="text-sm font-semibold">Strategies</h3>
								<span class="badge badge-ghost badge-sm">{selectedStrategies.length}</span>
							</div>
							<ul class="space-y-1 text-sm">
								{#if selectedStrategies.length === 0}
									<li class="text-base-content/60">No strategies yet.</li>
								{:else}
									{#each selectedStrategies as strategy (strategy.id)}
										<li class="rounded-lg bg-base-100 px-2 py-1.5">
											<div class="flex items-center justify-between gap-2">
												<span class="truncate font-medium">{strategy.title}</span>
												<span class="badge badge-xs">{strategy.status}</span>
											</div>
											<p class="mt-1 line-clamp-2 text-xs text-base-content/65">{strategy.summary}</p>
										</li>
									{/each}
								{/if}
							</ul>
						</div>
					</div>
				{/if}
			</section>
		</div>
	{/if}
</div>
