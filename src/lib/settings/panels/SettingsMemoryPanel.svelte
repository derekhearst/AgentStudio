<script lang="ts">
	import ContentPanel from '$lib/ui/ContentPanel.svelte'

	type MemoryConfig = {
		enabled: boolean
		topK: number
		useRerank: boolean
		rerankModel: string
		embeddingModel: string
		autoMine: boolean
	}

	let { memoryConfig }: { memoryConfig: MemoryConfig } = $props()
</script>

<ContentPanel>
	{#snippet header()}
		<h2 class="flex items-center gap-2 text-base font-semibold">
			<span class="h-1.5 w-1.5 rounded-full bg-accent"></span>
			Memory Palace
		</h2>
	{/snippet}
	<div class="grid gap-2 xl:grid-cols-2">
		<label class="flex items-center justify-between gap-3 rounded-md bg-base-200/40 px-3 py-2">
			<span>
				<span class="block text-sm font-medium">Enable memory recall</span>
				<span class="block text-xs text-base-content/55">Inject relevant past memories into chat as context.</span>
			</span>
			<input type="checkbox" class="checkbox checkbox-sm checkbox-accent" bind:checked={memoryConfig.enabled} />
		</label>
		<label class="flex items-center justify-between gap-3 rounded-md bg-base-200/40 px-3 py-2">
			<span>
				<span class="block text-sm font-medium">Auto-mine conversations</span>
				<span class="block text-xs text-base-content/55">Mine each conversation into the palace after completion.</span>
			</span>
			<input type="checkbox" class="checkbox checkbox-sm checkbox-accent" bind:checked={memoryConfig.autoMine} />
		</label>
		<label class="flex items-center justify-between gap-3 rounded-md bg-base-200/40 px-3 py-2">
			<span>
				<span class="block text-sm font-medium">Use LLM reranker</span>
				<span class="block text-xs text-base-content/55">Slower but typically improves retrieval precision.</span>
			</span>
			<input type="checkbox" class="checkbox checkbox-sm checkbox-accent" bind:checked={memoryConfig.useRerank} />
		</label>
		<label class="flex items-center justify-between gap-3 rounded-md bg-base-200/40 px-3 py-2">
			<span class="block text-sm font-medium">Top-K results</span>
			<input
				type="number"
				min="1"
				max="20"
				class="input input-sm input-bordered w-20"
				value={memoryConfig.topK}
				oninput={(e) => {
					const raw = Number((e.currentTarget as HTMLInputElement).value)
					memoryConfig.topK = Number.isFinite(raw) && raw >= 1 ? Math.min(20, Math.max(1, Math.round(raw))) : 1
				}}
			/>
		</label>
		<label class="flex items-center justify-between gap-3 rounded-md bg-base-200/40 px-3 py-2 xl:col-span-2">
			<span class="block text-sm font-medium">Rerank model</span>
			<input type="text" class="input input-sm input-bordered w-64 font-mono text-xs" bind:value={memoryConfig.rerankModel} />
		</label>
		<label class="flex items-center justify-between gap-3 rounded-md bg-base-200/40 px-3 py-2 xl:col-span-2">
			<span class="block text-sm font-medium">Embedding model</span>
			<input type="text" class="input input-sm input-bordered w-64 font-mono text-xs" bind:value={memoryConfig.embeddingModel} />
		</label>
	</div>
	<p class="text-xs text-base-content/55 pt-2">
		Browse and search your palace at <a href="/memory" class="link link-accent">/memory</a>.
	</p>
</ContentPanel>
