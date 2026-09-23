<script lang="ts">
	/**
	 * #38 — "what did the agents actually do?" at a glance, above the activity feed.
	 *
	 * Tokens lead and dollars follow, labelled metered: Claude subscription runs are logged
	 * at $0, so a dollar-first strip would make a busy week look free. Every number here is
	 * the same one the weekly digest prints — both come from `computeUsageDigest`.
	 */
	import {
		USAGE_DIGEST_WINDOW_DAYS,
		digestWindowLabel,
		formatDigestPct,
		formatDigestTokens,
		formatDigestUsd,
		type UsageDigest,
		type UsageDigestWindowDays,
	} from '$lib/costs/usage-digest';
	import WeeklyDigestOptIn from './WeeklyDigestOptIn.svelte';

	let {
		digest,
		days,
		loading,
		error,
		onWindowChange,
	}: {
		digest: UsageDigest | null;
		days: UsageDigestWindowDays;
		loading: boolean;
		error: string | null;
		onWindowChange: (days: UsageDigestWindowDays) => void;
	} = $props();

	const windowLabels: Record<UsageDigestWindowDays, string> = { 1: '24h', 7: '7d', 30: '30d' };

	// Already ranked failures first, then spend, then runs.
	const topAutomations = $derived(digest?.automations.items.slice(0, 2) ?? []);
	const tightest = $derived(digest?.budget.tightest ?? null);

	function automationUsage(automation: UsageDigest['automations']['items'][number]): string {
		const count =
			automation.failed > 0 ? `${automation.failed} failed` : `${automation.runs} run${automation.runs === 1 ? '' : 's'}`;
		return automation.costUsd > 0 ? `${count} · ${formatDigestUsd(automation.costUsd)}` : count;
	}

	function limitLabel(limit: NonNullable<UsageDigest['budget']['tightest']>): string {
		const scope = limit.scope === 'global' ? 'Global' : (limit.scopeLabel ?? limit.scope);
		return `${scope} · ${limit.period}`;
	}

	function sinceLabel(iso: string): string {
		return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
	}
</script>

<!--
	Tokens, then the metered dollars when there were any: for a gateway or OpenRouter model
	the dollars are what matters, and a subscription model's $0 would only be noise.
-->
{#snippet usage(row: { tokensIn: number; tokensOut: number; costUsd: number })}
	<span class="shrink-0 tabular-nums text-base-content/60" data-testid="usage-row-value">
		{formatDigestTokens(row.tokensIn + row.tokensOut)}{#if row.costUsd > 0}<span class="text-base-content/45">{` · ${formatDigestUsd(row.costUsd)}`}</span>{/if}
	</span>
{/snippet}

<section class="space-y-2" data-testid="usage-strip" aria-label="Usage summary" aria-busy={loading}>
	<!--
		The window switch lives here rather than in the page header: header actions are not
		shown between the phone and desktop breakpoints, and it belongs next to what it changes.
	-->
	<div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
		<div class="flex min-w-0 flex-wrap items-baseline gap-x-2">
			<h2 class="text-sm font-semibold">
				{#if digest}
					Last {digestWindowLabel(digest.days)}
				{:else}
					Usage
				{/if}
			</h2>
			{#if digest}
				<p class="text-[11px] text-base-content/55" data-testid="usage-window">since {sinceLabel(digest.since)}</p>
			{/if}
		</div>
		<div class="join" role="group" aria-label="Usage window">
			{#each USAGE_DIGEST_WINDOW_DAYS as option (option)}
				<button
					class="btn btn-xs join-item"
					class:btn-active={days === option}
					type="button"
					aria-pressed={days === option}
					data-testid="usage-window-{option}"
					onclick={() => onWindowChange(option)}
				>
					{windowLabels[option]}
				</button>
			{/each}
		</div>
	</div>

	{#if error && !digest}
		<p class="rounded-xl border border-base-300/60 bg-base-100 p-3 text-sm text-base-content/70">{error}</p>
	{:else if !digest}
		<div class="grid grid-cols-2 gap-2 tablet:grid-cols-4 tablet:gap-3" aria-hidden="true">
			{#each [0, 1, 2, 3] as i (i)}
				<div class="h-20 animate-pulse rounded-xl border border-base-300/60 bg-base-200/40"></div>
			{/each}
		</div>
	{:else}
		{#if digest.anomalies.length > 0}
			<ul class="flex flex-wrap gap-1.5" data-testid="usage-anomalies" aria-label="Needs a look">
				{#each digest.anomalies as anomaly, i (i)}
					{@const tone =
						anomaly.severity === 'critical'
							? 'border-error/40 bg-error/10 text-error'
							: 'border-warning/40 bg-warning/10 text-base-content'}
					<li class="max-w-full">
						{#if anomaly.href}
							<a
								href={anomaly.href}
								class="inline-flex max-w-full items-start gap-1.5 rounded-lg border px-2 py-1 text-xs hover:brightness-95 {tone}"
								data-kind={anomaly.kind}
							>
								<span class="mt-1 size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true"></span>
								<span class="min-w-0 break-words">{anomaly.message}</span>
							</a>
						{:else}
							<span class="inline-flex max-w-full items-start gap-1.5 rounded-lg border px-2 py-1 text-xs {tone}" data-kind={anomaly.kind}>
								<span class="mt-1 size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true"></span>
								<span class="min-w-0 break-words">{anomaly.message}</span>
							</span>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}

		<div class="grid grid-cols-2 gap-2 tablet:grid-cols-4 tablet:gap-3" class:opacity-60={loading}>
			<!-- Runs -->
			<div class="min-w-0 rounded-xl border border-base-300/60 bg-base-100 p-3" data-testid="usage-runs">
				<p class="text-[10px] uppercase tracking-wide text-base-content/55">Runs</p>
				<p class="mt-1 text-2xl font-bold leading-tight">{digest.runs.total}</p>
				<p class="mt-1 text-[11px] text-base-content/60">
					<a href="/review" class="link-hover" class:text-error={digest.runs.failed > 0}>
						{digest.runs.failed} failed{digest.runs.failureRate !== null ? ` (${formatDigestPct(digest.runs.failureRate)})` : ''}
					</a>
				</p>
				{#if digest.runs.inFlight > 0}
					<p class="text-[11px] text-base-content/55">{digest.runs.inFlight} in flight</p>
				{/if}
			</div>

			<!-- Tokens (the real measure) and metered dollars -->
			<div class="min-w-0 rounded-xl border border-base-300/60 bg-base-100 p-3" data-testid="usage-tokens">
				<p class="text-[10px] uppercase tracking-wide text-base-content/55">Tokens</p>
				<p class="mt-1 text-2xl font-bold leading-tight" title="Input + output tokens">{formatDigestTokens(digest.tokens.total)}</p>
				<p class="mt-1 truncate text-[11px] text-base-content/60">
					{formatDigestTokens(digest.tokens.in)} in · {formatDigestTokens(digest.tokens.out)} out
				</p>
				<p class="truncate text-[11px] text-base-content/55">{formatDigestTokens(digest.tokens.cacheRead)} cache read</p>
				<p
					class="truncate text-[11px] text-base-content/55"
					title={digest.hasSubscriptionUsage
						? 'Metered spend only: Claude subscription runs are logged at $0.'
						: 'Metered spend: what gateway models, OpenRouter calls and paid tools charged.'}
					data-testid="usage-metered"
				>
					{formatDigestUsd(digest.metered.usd)} metered{digest.hasSubscriptionUsage ? '*' : ''}
				</p>
			</div>

			<!-- Automations -->
			<div class="min-w-0 rounded-xl border border-base-300/60 bg-base-100 p-3" data-testid="usage-automations">
				<p class="text-[10px] uppercase tracking-wide text-base-content/55">Automation runs</p>
				<p class="mt-1 text-2xl font-bold leading-tight">{digest.automations.runs}</p>
				<p class="mt-1 text-[11px] text-base-content/60">
					<span class:text-error={digest.automations.failed > 0}>{digest.automations.failed} failed</span>
					{#if digest.automations.costUsd > 0}· {formatDigestUsd(digest.automations.costUsd)}{/if}
				</p>
				{#if topAutomations.length > 0}
					<ul class="mt-1 space-y-0.5">
						{#each topAutomations as automation (automation.automationId)}
							<li class="flex items-baseline justify-between gap-2 text-[11px]" data-testid="usage-automation">
								<a
									href="/automations"
									class="link-hover min-w-0 truncate"
									class:text-error={automation.failed > 0}
									title={automation.description}
								>
									{automation.description}
								</a>
								<span class="shrink-0 tabular-nums text-base-content/60">{automationUsage(automation)}</span>
							</li>
						{/each}
					</ul>
				{/if}
			</div>

			<!-- Review inbox -->
			<div class="min-w-0 rounded-xl border border-base-300/60 bg-base-100 p-3" data-testid="usage-inbox">
				<p class="text-[10px] uppercase tracking-wide text-base-content/55">Review inbox</p>
				<p class="mt-1 text-2xl font-bold leading-tight" class:text-warning={digest.inbox.open > 0}>
					<a href="/review" class="link-hover">{digest.inbox.open}</a>
				</p>
				<p class="mt-1 text-[11px] text-base-content/60">
					{#if digest.inbox.open > 0}
						<span class:text-error={digest.inbox.critical > 0}>{digest.inbox.critical} critical</span> · {digest.inbox.warning} warning
					{:else}
						Nothing waiting
					{/if}
				</p>
			</div>

			<!-- Budget headroom -->
			<div class="min-w-0 rounded-xl border border-base-300/60 bg-base-100 p-3" data-testid="usage-budget">
				<p class="text-[10px] uppercase tracking-wide text-base-content/55">Budget</p>
				{#if tightest}
					<p
						class="mt-1 text-2xl font-bold leading-tight"
						class:text-error={tightest.pct >= 1}
						class:text-warning={tightest.pct >= 0.8 && tightest.pct < 1}
					>
						{formatDigestPct(tightest.pct)}
					</p>
					<p class="mt-1 truncate text-[11px] text-base-content/60">
						{formatDigestUsd(tightest.spendUsd)} of {formatDigestUsd(tightest.limitUsd)}
					</p>
					<p class="truncate text-[11px] text-base-content/55">{limitLabel(tightest)}{digest.budget.limits.length > 1 ? ` · +${digest.budget.limits.length - 1} more` : ''}</p>
				{:else}
					<p class="mt-1 text-sm font-semibold leading-tight text-base-content/70">No limits set</p>
				{/if}
			</div>

			<!-- Top models -->
			<div class="min-w-0 rounded-xl border border-base-300/60 bg-base-100 p-3" data-testid="usage-models">
				<p class="text-[10px] uppercase tracking-wide text-base-content/55">Top models</p>
				{#if digest.models.length === 0}
					<p class="mt-1 text-[11px] text-base-content/55">No model calls</p>
				{:else}
					<ul class="mt-1 space-y-0.5">
						{#each digest.models.slice(0, 3) as model (model.model)}
							<li class="flex items-baseline justify-between gap-2 text-[11px]">
								<span class="min-w-0 truncate font-mono" title={model.model}>{model.model.split('/').pop()}</span>
								{@render usage(model)}
							</li>
						{/each}
					</ul>
				{/if}
			</div>

			<!-- Top agents -->
			<div class="min-w-0 rounded-xl border border-base-300/60 bg-base-100 p-3" data-testid="usage-agents">
				<p class="text-[10px] uppercase tracking-wide text-base-content/55">Top agents</p>
				{#if digest.agents.length === 0}
					<p class="mt-1 text-[11px] text-base-content/55">No agent runs</p>
				{:else}
					<ul class="mt-1 space-y-0.5">
						{#each digest.agents.slice(0, 3) as agent (agent.agentId)}
							<li class="flex items-baseline justify-between gap-2 text-[11px]">
								<a href="/agents/{agent.agentId}" class="link-hover min-w-0 truncate">{agent.name ?? 'Deleted agent'}</a>
								{@render usage(agent)}
							</li>
						{/each}
					</ul>
				{/if}
			</div>

			<!-- Most-used tools -->
			<div class="min-w-0 rounded-xl border border-base-300/60 bg-base-100 p-3" data-testid="usage-tools">
				<div class="flex items-baseline justify-between gap-2">
					<p class="text-[10px] uppercase tracking-wide text-base-content/55">Tool calls</p>
					<span class="text-[10px] tabular-nums text-base-content/55">
						{digest.tools.calls}{digest.tools.failed > 0 ? ` · ${digest.tools.failed} failed` : ''}
					</span>
				</div>
				{#if digest.tools.top.length === 0}
					<p class="mt-1 text-[11px] text-base-content/55">No tool calls</p>
				{:else}
					<ul class="mt-1 space-y-0.5">
						{#each digest.tools.top as tool (tool.toolName)}
							<li class="flex items-baseline justify-between gap-2 text-[11px]">
								<span class="min-w-0 truncate font-mono" title={tool.toolName}>{tool.toolName}</span>
								<span class="shrink-0 tabular-nums text-base-content/60">{tool.calls}</span>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</div>

		<div class="flex flex-col gap-2 tablet:flex-row tablet:items-start tablet:justify-between">
			<p class="text-[11px] text-base-content/50">
				{#if digest.hasSubscriptionUsage}* Claude subscription runs are logged at $0, so tokens are the real measure.{/if}
				Tool calls made by agent-attached automations, monitors and PR fixes are not counted yet.
			</p>
			<WeeklyDigestOptIn />
		</div>
	{/if}
</section>
