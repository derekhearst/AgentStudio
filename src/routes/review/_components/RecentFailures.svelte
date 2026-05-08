<script lang="ts">
	import type { listRecentFailuresQuery } from '$lib/observability/review.remote';

	type Result = Awaited<ReturnType<typeof listRecentFailuresQuery>>;
	type Failure = Extract<Result, { adminOnly: false }>['failures'][number];

	let { failures }: { failures: Failure[] } = $props();

	function fmtAge(d: Date | string) {
		const now = Date.now();
		const t = new Date(d).getTime();
		const ms = Math.max(0, now - t);
		if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
		if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
		if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
		return `${Math.round(ms / 86_400_000)}d ago`;
	}

	function kindBadge(kind: 'run_failed' | 'tool_failed'): string {
		return kind === 'run_failed' ? 'badge-error' : 'badge-warning';
	}

	function kindLabel(kind: 'run_failed' | 'tool_failed'): string {
		return kind === 'run_failed' ? 'run' : 'tool';
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
					href="/review/trace/{failure.runId}"
					class="flex items-center gap-2 rounded-xl border border-base-300/60 bg-base-100 px-3 py-2 text-sm hover:bg-base-200/40"
				>
					<span class="badge badge-xs {kindBadge(failure.kind)}">{kindLabel(failure.kind)}</span>
					<span class="line-clamp-1 flex-1 text-xs leading-tight">{failure.label}</span>
					<span class="font-mono text-[10px] text-base-content/40">{failure.runId.slice(0, 8)}</span>
					<span class="font-mono text-[10px] text-base-content/55">{fmtAge(failure.occurredAt)}</span>
					<span class="text-xs text-base-content/40">→</span>
				</a>
			</li>
		{/each}
	</ul>
{/if}
