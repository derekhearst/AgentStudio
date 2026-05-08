<script lang="ts">
	import ContentPanel from '$lib/ui/ContentPanel.svelte'

	type BudgetConfig = {
		dailyLimit: number | null
		monthlyLimit: number | null
	}

	let { budgetConfig }: { budgetConfig: BudgetConfig } = $props()

	function parseLimit(raw: string): number | null {
		const trimmed = raw.trim()
		if (trimmed === '') return null
		const parsed = Math.max(0, Number(trimmed))
		return Number.isNaN(parsed) ? null : parsed
	}
</script>

<ContentPanel>
	{#snippet header()}
		<div>
			<h2 class="flex items-center gap-2 text-base font-semibold">
				<span class="h-1.5 w-1.5 rounded-full bg-warning"></span>
				Budget
			</h2>
			<p class="mt-0.5 text-xs text-base-content/55">Alerts trigger at 80% and 100%</p>
		</div>
	{/snippet}
	<div class="grid gap-x-6 gap-y-0 divide-y divide-base-300/50 sm:grid-cols-2 sm:divide-y-0">
		<div class="flex items-center justify-between gap-4 py-3.5 first:pt-0 sm:py-2">
			<p class="text-sm font-medium">Daily limit</p>
			<div class="flex items-center gap-1.5">
				<span class="text-xs text-base-content/50">$</span>
				<input
					type="number"
					class="input input-bordered input-sm w-28 text-right font-mono"
					min="0"
					step="0.01"
					placeholder="No limit"
					value={budgetConfig.dailyLimit ?? ''}
					oninput={(e) => {
						budgetConfig.dailyLimit = parseLimit((e.currentTarget as HTMLInputElement).value)
					}}
				/>
			</div>
		</div>
		<div class="flex items-center justify-between gap-4 py-3.5 last:pb-0 sm:py-2">
			<p class="text-sm font-medium">Monthly limit</p>
			<div class="flex items-center gap-1.5">
				<span class="text-xs text-base-content/50">$</span>
				<input
					type="number"
					class="input input-bordered input-sm w-28 text-right font-mono"
					min="0"
					step="0.01"
					placeholder="No limit"
					value={budgetConfig.monthlyLimit ?? ''}
					oninput={(e) => {
						budgetConfig.monthlyLimit = parseLimit((e.currentTarget as HTMLInputElement).value)
					}}
				/>
			</div>
		</div>
	</div>
</ContentPanel>
