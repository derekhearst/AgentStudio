<svelte:head><title>Tools | DrokBot</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import { getSettings, updateDisabledToolsCommand } from '$lib/settings';
	import { BUILTIN_TOOLS, type BuiltinTool } from '$lib/llm/tool-registry';
	import ContentPanel from '$lib/components/ui/ContentPanel.svelte';

	let search = $state('');
	let busy = $state(false);
	let tools = $state<BuiltinTool[]>([]);
	let disabledTools = $state<Set<string>>(new Set());
	let filterTimer: ReturnType<typeof setTimeout> | undefined;

	onMount(() => {
		void loadInitialData();
	});

	async function loadInitialData() {
		try {
			const settings = await getSettings();
			disabledTools = new Set(settings.toolConfig?.disabledTools ?? []);
		} catch {
			disabledTools = new Set();
		} finally {
			filterLocally();
		}
	}

	function filterLocally() {
		const q = search.trim().toLowerCase();
		tools = BUILTIN_TOOLS.filter((tool) => {
			if (!q) return true;
			return (
				tool.name.toLowerCase().includes(q) ||
				tool.description.toLowerCase().includes(q) ||
				tool.groupLabel.toLowerCase().includes(q)
			);
		});
	}

	function handleSearchInput() {
		clearTimeout(filterTimer);
		filterTimer = setTimeout(filterLocally, 150);
	}

	async function handleToggleTool(toolName: string) {
		if (busy) return;
		busy = true;
		try {
			const next = new Set(disabledTools);
			if (next.has(toolName)) {
				next.delete(toolName);
			} else {
				next.add(toolName);
			}
			await updateDisabledToolsCommand({ disabledTools: [...next].sort() });
			disabledTools = next;
		} finally {
			busy = false;
		}
	}
</script>

<div class="flex h-full min-h-0 flex-col space-y-3 sm:space-y-4">
	<ContentPanel>
		{#snippet header()}
			<div>
				<h1 class="text-xl font-bold sm:text-3xl">Tools</h1>
				<p class="text-xs text-base-content/70 sm:text-sm">
					{tools.length} {tools.length === 1 ? 'tool' : 'tools'} - Built-in tool registry and toggles
				</p>
			</div>
		{/snippet}
	</ContentPanel>

	<div class="flex shrink-0 items-center gap-2">
		<input
			class="input input-bordered input-md flex-1"
			bind:value={search}
			oninput={handleSearchInput}
			placeholder="Search tools..."
		/>
	</div>

	<div class="min-h-0 flex-1 overflow-y-auto rounded-xl bg-base-200/40 px-3 sm:px-4">
		{#if tools.length === 0}
			<div class="flex flex-col items-center gap-2 py-16 opacity-50">
				<svg xmlns="http://www.w3.org/2000/svg" class="size-12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
					<path d="M12 2v20"/>
					<path d="M2 12h20"/>
				</svg>
				<p class="text-sm">No tools match your search.</p>
			</div>
		{:else}
			<div class="space-y-2">
				{#each tools as tool (tool.name)}
					<div class="rounded-xl border border-base-300 bg-base-100 p-4 transition-colors hover:border-base-content/20">
						<div class="flex items-start justify-between gap-3">
							<div class="min-w-0 flex-1">
								<div class="flex items-center gap-2">
									<h3 class="font-semibold">{tool.name}</h3>
									<span class="badge badge-outline badge-xs">{tool.groupLabel}</span>
									{#if disabledTools.has(tool.name)}
										<span class="badge badge-ghost badge-xs">disabled</span>
									{/if}
								</div>
								<p class="mt-0.5 text-sm opacity-60">{tool.description}</p>
							</div>
							<div class="flex shrink-0 items-center gap-2">
								<input
									type="checkbox"
									class="toggle toggle-sm toggle-primary"
									checked={!disabledTools.has(tool.name)}
									onchange={() => handleToggleTool(tool.name)}
									title={!disabledTools.has(tool.name) ? 'Disable tool' : 'Enable tool'}
								/>
							</div>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>
