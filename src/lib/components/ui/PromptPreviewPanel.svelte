<script lang="ts">
	import { onMount } from 'svelte';
	import { getFullPromptPreview } from '$lib/settings';

	type PromptPreview = Awaited<ReturnType<typeof getFullPromptPreview>>;

	let preview = $state<PromptPreview | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let activeTab = $state<'simple' | 'complex'>('simple');

	onMount(() => {
		void load();
	});

	async function load() {
		loading = true;
		error = null;
		try {
			preview = await getFullPromptPreview();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load prompt preview';
		} finally {
			loading = false;
		}
	}

	function formatTokens(n: number): string {
		if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
		return String(n);
	}

	let scenario = $derived(preview ? preview.scenarios[activeTab] : null);
</script>

<div class="flex h-full flex-col">
	<div class="flex items-center justify-between px-1 pb-3">
		<h2 class="text-sm font-bold tracking-tight">Context Explorer</h2>
		<button class="btn btn-ghost btn-xs btn-circle" type="button" onclick={load} disabled={loading} aria-label="Refresh">
			{#if loading}
				<span class="loading loading-spinner loading-xs"></span>
			{:else}
				<svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M21 2v6h-6"></path>
					<path d="M3 11a9 9 0 0 1 15-6.7L21 8"></path>
					<path d="M3 22v-6h6"></path>
					<path d="M21 13a9 9 0 0 1-15 6.7L3 16"></path>
				</svg>
			{/if}
		</button>
	</div>

	{#if error}
		<p class="rounded-lg bg-error/10 p-2 text-xs text-error">{error}</p>
	{:else if loading && !preview}
		<div class="flex flex-1 items-center justify-center">
			<span class="loading loading-spinner loading-md text-base-content/30"></span>
		</div>
	{:else if preview && scenario}
		<div class="flex-1 space-y-3 overflow-y-auto">
			<!-- Scenario Tabs -->
			<div class="tabs tabs-boxed tabs-xs bg-base-200/50">
				<button class="tab" class:tab-active={activeTab === 'simple'} onclick={() => activeTab = 'simple'}>Simple</button>
				<button class="tab" class:tab-active={activeTab === 'complex'} onclick={() => activeTab = 'complex'}>Complex</button>
			</div>

			<!-- Meta -->
			<div class="flex flex-wrap gap-x-3 gap-y-1 rounded-lg bg-base-200/50 px-2.5 py-2 text-[10px] text-base-content/50">
				<span>Model: <span class="font-mono text-base-content/70">{preview.model}</span></span>
				<span>Tools: <span class="font-mono text-base-content/70">{scenario.toolCount}</span></span>
				<span>~<span class="font-mono text-base-content/70">{formatTokens(scenario.estimatedTokens)}</span> tokens</span>
				{#if scenario.capabilities.length > 0}
					<span>Groups: <span class="font-mono text-base-content/70">{scenario.capabilities.join(', ')}</span></span>
				{/if}
			</div>

			<!-- Raw message parts -->
			{#each scenario.parts as part}
				<div>
					<p class="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-base-content/40">
						<span class="inline-block h-1 w-1 rounded-full bg-secondary"></span>
						{part.label}
					</p>
					<pre class="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-lg bg-base-200/50 p-2 font-mono text-[10px] leading-relaxed text-base-content/70">{part.content}</pre>
				</div>
			{/each}
		</div>
	{/if}
</div>
