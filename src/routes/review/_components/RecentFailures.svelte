<script lang="ts">
	import type { listRecentFailuresQuery } from '$lib/observability/review.remote';
	import { formatCost } from '$lib/agents/agent-format';
	import { relativeTime } from '$lib/util/relative-time';

	type Result = Awaited<ReturnType<typeof listRecentFailuresQuery>>;
	type Failure = Extract<Result, { adminOnly: false }>['failures'][number];

	let { failures }: { failures: Failure[] } = $props();

	const fmtAge = (d: Date | string) => relativeTime(d);

	function kindBadge(kind: 'run_failed' | 'tool_failed'): string {
		return kind === 'run_failed' ? 'badge-error' : 'badge-warning';
	}

	function kindLabel(kind: 'run_failed' | 'tool_failed'): string {
		return kind === 'run_failed' ? 'run' : 'tool';
	}

	// A failed run opens its run page, which every run has; most runs have no trace, so the
	// trace viewer would only say so. A failed tool call lives in a trace span.
	function failureHref(failure: Failure): string {
		return failure.kind === 'run_failed' ? `/runs/${failure.runId}` : `/review/trace/${failure.runId}`;
	}
</script>

{#if failures.length === 0}
	<div class="rounded-xl border border-base-300/60 bg-base-200/30 p-6 text-center text-sm text-base-content/55">
		No failures in the last 24h.
	</div>
{:else}
	<ul class="space-y-1">
		{#each failures as failure (failure.runId + '-' + failure.kind + '-' + new Date(failure.occurredAt).getTime())}
			<li>
				<a
					href={failureHref(failure)}
					data-testid="recent-failure"
					class="flex flex-wrap items-center gap-2 rounded-xl border border-base-300/60 bg-base-100 px-3 py-2 text-sm hover:bg-base-200/40 tablet:flex-nowrap"
				>
					<span class="badge badge-xs {kindBadge(failure.kind)}">{kindLabel(failure.kind)}</span>
					<span class="order-last line-clamp-1 w-full text-xs leading-tight tablet:order-none tablet:w-auto tablet:min-w-0 tablet:flex-1">{failure.label}</span>
					<span class="font-mono text-[10px] text-base-content/40">{failure.runId.slice(0, 8)}</span>
					{#if failure.costUsd !== null}
						<span
							class="font-mono text-[10px] text-base-content/55"
							data-testid="recent-failure-cost"
							title="What the run cost, from the usage ledger"
						>
							{formatCost(failure.costUsd)}
						</span>
					{/if}
					<span class="font-mono text-[10px] text-base-content/55">{fmtAge(failure.occurredAt)}</span>
					<span class="text-xs text-base-content/40">→</span>
				</a>
			</li>
		{/each}
	</ul>
{/if}
