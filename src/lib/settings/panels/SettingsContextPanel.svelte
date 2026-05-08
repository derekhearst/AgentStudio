<script lang="ts">
	import ContentPanel from '$lib/ui/ContentPanel.svelte'

	type ContextConfig = {
		reservedResponsePct: number
		autoCompactThresholdPct: number
		preserveToolResults?: string[]
	}

	let { contextConfig }: { contextConfig: ContextConfig } = $props()
</script>

<ContentPanel>
	{#snippet header()}
		<h2 class="flex items-center gap-2 text-base font-semibold">
			<span class="h-1.5 w-1.5 rounded-full bg-secondary"></span>
			Context Window
		</h2>
	{/snippet}
	<div class="grid gap-x-6 gap-y-0 divide-y divide-base-300/50 xl:grid-cols-2 xl:divide-y-0">
		<!-- Reserved Response -->
		<div class="py-3.5 first:pt-0 xl:py-3.5">
			<div class="flex items-center justify-between">
				<p class="text-sm font-medium">Reserved Response</p>
				<span class="rounded-md bg-secondary/10 px-2 py-0.5 font-mono text-xs text-secondary">{contextConfig.reservedResponsePct.toFixed(0)}%</span>
			</div>
			<input
				type="range"
				min="10"
				max="40"
				step="1"
				class="range range-secondary range-xs mt-3"
				bind:value={contextConfig.reservedResponsePct}
			/>
			<p class="mt-1.5 text-xs text-base-content/55">Size of the striped reserved segment in the context bar</p>
		</div>

		<!-- Auto-Compact Threshold -->
		<div class="py-3.5 xl:py-3.5">
			<div class="flex items-center justify-between">
				<p class="text-sm font-medium">Auto-Compact Threshold</p>
				<span class="rounded-md bg-secondary/10 px-2 py-0.5 font-mono text-xs text-secondary">{contextConfig.autoCompactThresholdPct.toFixed(0)}%</span>
			</div>
			<input
				type="range"
				min="40"
				max="95"
				step="1"
				class="range range-secondary range-xs mt-3"
				bind:value={contextConfig.autoCompactThresholdPct}
			/>
			<p class="mt-1.5 text-xs text-base-content/55">Auto-compaction triggers when a model switch would exceed this</p>
		</div>
	</div>
</ContentPanel>
