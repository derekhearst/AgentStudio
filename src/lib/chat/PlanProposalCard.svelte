<script lang="ts">
	type PlanStep = {
		title: string
		detail?: string
		estimatedDurationMin?: number
		estimatedCostUsd?: number
		blastRadius?: 'local' | 'shared' | 'production'
		reversible?: boolean
	}

	type Plan = {
		summary: string
		steps: PlanStep[]
		risks?: string[]
		rollback?: string
		totalEstimatedCostUsd?: number
		totalEstimatedDurationMin?: number
	}

	type Status = 'pending' | 'approved' | 'executing' | 'completed' | 'denied' | 'failed'

	let {
		plan,
		status = 'pending',
		token = null,
		onApprove,
		onDeny,
	} = $props<{
		plan: Plan
		status?: Status
		token?: string | null
		onApprove?: ((token: string) => void | Promise<void>) | undefined
		onDeny?: ((token: string) => void | Promise<void>) | undefined
	}>()

	const isPending = $derived(status === 'pending')
	const isApproved = $derived(status === 'approved' || status === 'executing' || status === 'completed')
	const isDenied = $derived(status === 'denied' || status === 'failed')

	const containerClass = $derived(
		isDenied
			? 'border-error/50 bg-error/5'
			: isApproved
				? 'border-success/50 bg-success/5'
				: 'border-warning/50 bg-warning/5',
	)

	const headerLabel = $derived(
		isDenied ? 'Plan denied' : isApproved ? 'Plan approved' : 'Plan awaiting approval',
	)

	function blastBadge(blast: PlanStep['blastRadius']) {
		if (!blast) return ''
		if (blast === 'production') return 'badge-error'
		if (blast === 'shared') return 'badge-warning'
		return 'badge-info'
	}

	function fmtUsd(n: number | undefined) {
		if (n === undefined) return ''
		return n < 0.01 ? `<$0.01` : `$${n.toFixed(2)}`
	}

	function fmtMin(n: number | undefined) {
		if (n === undefined) return ''
		if (n < 60) return `~${n}m`
		const h = Math.floor(n / 60)
		const m = n % 60
		return m === 0 ? `~${h}h` : `~${h}h ${m}m`
	}

	async function handleApprove() {
		if (!token || !onApprove) return
		await onApprove(token)
	}

	async function handleDeny() {
		if (!token || !onDeny) return
		await onDeny(token)
	}
</script>

<article class="plan-proposal-card chat chat-start w-full">
	<div class={`card card-body w-full max-w-full rounded-2xl border ${containerClass} px-4 py-3`}>
		<header class="mb-3 flex items-center gap-2 text-sm">
			<span class={`badge badge-sm ${isDenied ? 'badge-error' : isApproved ? 'badge-success' : 'badge-warning'}`}>
				{headerLabel}
			</span>
			<span class="font-medium leading-tight">{plan.summary}</span>
		</header>

		<ol class="space-y-2 text-sm">
			{#each plan.steps as step, idx (idx)}
				<li class="rounded-xl border border-base-300/50 bg-base-100/40 px-3 py-2">
					<div class="flex flex-wrap items-center gap-2">
						<span class="font-mono text-xs text-base-content/60 tabular-nums">{idx + 1}.</span>
						<span class="font-medium leading-tight">{step.title}</span>
						{#if step.blastRadius}
							<span class={`badge badge-xs ${blastBadge(step.blastRadius)}`}>{step.blastRadius}</span>
						{/if}
						{#if step.reversible === false}
							<span class="badge badge-xs badge-error">irreversible</span>
						{/if}
						<span class="ml-auto flex items-center gap-2 font-mono text-xs tabular-nums text-base-content/60">
							{#if step.estimatedDurationMin !== undefined}
								<span>{fmtMin(step.estimatedDurationMin)}</span>
							{/if}
							{#if step.estimatedCostUsd !== undefined}
								<span>{fmtUsd(step.estimatedCostUsd)}</span>
							{/if}
						</span>
					</div>
					{#if step.detail}
						<p class="mt-1 text-xs leading-snug text-base-content/80">{step.detail}</p>
					{/if}
				</li>
			{/each}
		</ol>

		{#if plan.risks && plan.risks.length > 0}
			<div class="mt-3">
				<p class="text-xs font-semibold uppercase tracking-wide text-base-content/60">Risks</p>
				<ul class="mt-1 list-disc pl-5 text-xs leading-snug">
					{#each plan.risks as risk (risk)}
						<li>{risk}</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if plan.rollback}
			<div class="mt-3">
				<p class="text-xs font-semibold uppercase tracking-wide text-base-content/60">Rollback</p>
				<p class="mt-1 text-xs leading-snug">{plan.rollback}</p>
			</div>
		{/if}

		{#if plan.totalEstimatedCostUsd !== undefined || plan.totalEstimatedDurationMin !== undefined}
			<div class="mt-3 flex items-center gap-3 border-t border-base-300/40 pt-2 font-mono text-xs tabular-nums text-base-content/70">
				<span class="text-xs font-semibold uppercase tracking-wide text-base-content/60">Total</span>
				{#if plan.totalEstimatedDurationMin !== undefined}
					<span>{fmtMin(plan.totalEstimatedDurationMin)}</span>
				{/if}
				{#if plan.totalEstimatedCostUsd !== undefined}
					<span>{fmtUsd(plan.totalEstimatedCostUsd)}</span>
				{/if}
			</div>
		{/if}

		{#if isPending && token && (onApprove || onDeny)}
			<footer class="mt-3 flex items-center justify-end gap-2 border-t border-base-300/40 pt-3">
				{#if onDeny}
					<button class="btn btn-ghost btn-sm" type="button" onclick={handleDeny}>Deny</button>
				{/if}
				{#if onApprove}
					<button class="btn btn-success btn-sm" type="button" onclick={handleApprove}>Approve plan</button>
				{/if}
			</footer>
		{/if}
	</div>
</article>
