<script lang="ts">
	let {
		used = 0,
		total = 128000,
		breakdown,
		modelUsage = [],
		reservedTargetPct = 30,
		onCompact
	} = $props<{
		used?: number;
		total?: number;
		reserved?: number;
		breakdown?: { system: number; tools: number; messages: number; results: number; other: number };
		modelUsage?: Array<{ label: string; value: number; color?: string }>;
		reservedTargetPct?: number;
		onCompact?: (() => Promise<void> | void) | undefined;
	}>();

	const pct = $derived(total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0);
	const usedK = $derived((used / 1000).toFixed(1));
	const totalK = $derived((total / 1000).toFixed(0));
	const reservedPct = $derived(Math.max(0, Math.min(reservedTargetPct, 100 - pct)));
	const reservedStart = $derived(Math.max(0, Math.min(100, pct)));
	const ringDegrees = $derived(Math.max(0, Math.min(360, (pct / 100) * 360)));
	const formatPct = (value: number) => `${Number(value.toFixed(1))}%`;

	const systemRows = $derived([
		{ label: 'System Instructions', value: breakdown?.system ?? 0 },
		{ label: 'Tool Definitions', value: breakdown?.tools ?? 0 }
	]);

	const userRows = $derived([
		{ label: 'Messages', value: breakdown?.messages ?? 0 },
		{ label: 'Tool Results', value: breakdown?.results ?? 0 }
	]);

	const uncategorizedRows = $derived([
		{ label: 'Other', value: breakdown?.other ?? 0 }
	]);
</script>

<div class="dropdown dropdown-end dropdown-hover">
	<div
		tabindex="0"
		role="button"
		class="context-ring flex h-9 w-9 cursor-default items-center justify-center rounded-full border border-base-300 text-[11px] font-semibold tabular-nums"
		style={`--ctx-fill:${ringDegrees}deg;`}
		aria-label={`Context window usage ${pct}%`}
	>
		<span>{pct}%</span>
	</div>

	<div tabindex="-1" class="dropdown-content z-30 w-72 px-2 pt-2">
		<div class="rounded-xl border border-base-300 bg-base-100/95 p-3 text-sm shadow-xl backdrop-blur">
		<h3 class="mb-1 text-base font-semibold">Context Window</h3>
		<p class="font-mono text-xs opacity-80">{usedK}K / {totalK}K tokens</p>

		<div class="mt-2 flex items-center gap-2">
			<div class="ctx-track relative h-2 flex-1 overflow-hidden rounded-full border border-base-300/60 bg-base-200/70">
				<div class="ctx-used absolute inset-y-0 left-0 bg-primary/75" style={`width:${pct}%`}></div>
				<div
					class="ctx-reserved-bar absolute inset-y-0"
					style={`left:${reservedStart}%; width:${reservedPct}%`}
				></div>
			</div>
			<span class="w-10 text-right text-xs tabular-nums opacity-75">{formatPct(pct)}</span>
		</div>

		<div class="mt-2 flex items-center gap-2 text-xs opacity-75">
			<span class="inline-block h-2.5 w-2.5 rounded-[2px] border border-primary/70 bg-primary/70"></span>
			<span>Used by prompt</span>
		</div>
		<div class="mt-1 flex items-center gap-2 text-xs opacity-75">
			<span class="context-reserved inline-block h-2.5 w-2.5 rounded-[2px] border border-primary/50"></span>
			<span>Reserved for response</span>
			<span class="ml-auto tabular-nums">{formatPct(reservedPct)}</span>
		</div>

		<div class="mt-3 space-y-1">
			<p class="text-xs font-semibold uppercase tracking-wide opacity-60">Model Usage</p>
			<div class="mt-1 flex h-2 overflow-hidden rounded-full border border-base-300/60 bg-base-200/70">
				{#each modelUsage as model (model.label)}
					<div style={`width:${model.value}%;background:${model.color ?? 'var(--color-primary)'}`}></div>
				{/each}
			</div>
			{#if modelUsage.length === 0}
				<p class="text-xs opacity-60">No model usage yet</p>
			{:else}
				{#each modelUsage as model (model.label)}
					<div class="flex items-center justify-between text-sm">
						<span class="flex items-center gap-2 opacity-85">
							<span class="inline-block h-2.5 w-2.5 rounded-full" style={`background:${model.color ?? 'var(--color-primary)'}`}></span>
							{model.label}
						</span>
						<span class="tabular-nums opacity-75">{formatPct(model.value)}</span>
					</div>
				{/each}
			{/if}
		</div>

		<div class="mt-3 space-y-1">
			<p class="text-xs font-semibold uppercase tracking-wide opacity-60">System</p>
			{#each systemRows as row (row.label)}
				<div class="flex items-center justify-between text-sm">
					<span class="opacity-85">{row.label}</span>
					<span class="tabular-nums opacity-75">{formatPct(row.value)}</span>
				</div>
			{/each}
		</div>

		<div class="mt-3 space-y-1">
			<p class="text-xs font-semibold uppercase tracking-wide opacity-60">User Context</p>
			{#each userRows as row (row.label)}
				<div class="flex items-center justify-between text-sm">
					<span class="opacity-85">{row.label}</span>
					<span class="tabular-nums opacity-75">{formatPct(row.value)}</span>
				</div>
			{/each}
		</div>

		<div class="mt-3 space-y-1">
			<p class="text-xs font-semibold uppercase tracking-wide opacity-60">Uncategorized</p>
			{#each uncategorizedRows as row (row.label)}
				<div class="flex items-center justify-between text-sm">
					<span class="opacity-85">{row.label}</span>
					<span class="tabular-nums opacity-75">{formatPct(row.value)}</span>
				</div>
			{/each}
		</div>

		{#if onCompact}
			<button class="btn btn-sm mt-3 w-full" type="button" onclick={() => onCompact?.()}>
				Compact Conversation
			</button>
		{/if}
		</div>
	</div>
</div>

<style>
	.context-ring {
		background:
			radial-gradient(circle, var(--color-base-100) 60%, transparent 61%),
			conic-gradient(var(--color-primary) var(--ctx-fill), color-mix(in oklab, var(--color-base-300) 82%, transparent) 0deg);
	}

	.context-reserved {
		background-image: repeating-linear-gradient(
			-45deg,
			color-mix(in oklab, var(--color-primary) 65%, transparent) 0,
			color-mix(in oklab, var(--color-primary) 65%, transparent) 2px,
			transparent 2px,
			transparent 5px
		);
	}

	.ctx-reserved-bar {
		background-image: repeating-linear-gradient(
			-45deg,
			color-mix(in oklab, var(--color-primary) 60%, transparent) 0,
			color-mix(in oklab, var(--color-primary) 60%, transparent) 2px,
			transparent 2px,
			transparent 6px
		);
	}
</style>
