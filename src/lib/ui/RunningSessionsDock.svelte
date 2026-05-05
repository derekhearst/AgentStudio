<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';
	import { dismissStuckRunCommand } from '$lib/runs/runs.remote';

	type LiveRun = {
		id: string;
		conversationId: string;
		state: 'queued' | 'running' | 'waiting_tool_approval' | 'waiting_user_input';
		label?: string | null;
		lastDelta?: string | null;
		updatedAt?: string | Date | null;
	};

	let runs = $state<LiveRun[]>([]);
	let dismissingId = $state<string | null>(null);

	async function handleDismiss(event: MouseEvent, runId: string) {
		// Stop the click from bubbling up to the parent <a> (which would navigate to the chat).
		event.preventDefault();
		event.stopPropagation();
		if (dismissingId) return;
		dismissingId = runId;
		try {
			await dismissStuckRunCommand({ runId });
			// Optimistically drop the row from the local list — the next monitor SSE tick will
			// confirm by sending a runs array that no longer includes this id.
			runs = runs.filter((r) => r.id !== runId);
		} catch (err) {
			console.warn('[RunningSessionsDock] dismiss failed', err);
		} finally {
			dismissingId = null;
		}
	}

	function stateChipClass(state: LiveRun['state']): string {
		switch (state) {
			case 'running':
				return 'bg-success/20 text-success';
			case 'queued':
				return 'bg-base-300/50 text-base-content/60';
			case 'waiting_tool_approval':
			case 'waiting_user_input':
				return 'bg-warning/20 text-warning';
			default:
				return 'bg-base-300/50 text-base-content/60';
		}
	}

	function stateLabel(state: LiveRun['state']): string {
		switch (state) {
			case 'running':
				return 'Running';
			case 'queued':
				return 'Queued';
			case 'waiting_tool_approval':
				return 'Needs approval';
			case 'waiting_user_input':
				return 'Waiting for you';
		}
	}

	const pendingCount = $derived(
		runs.filter((r) => r.state === 'waiting_tool_approval' || r.state === 'waiting_user_input').length
	);

	onMount(() => {
		if (!browser) return;

		const source = new EventSource('/api/chat/monitor');
		source.onmessage = (event) => {
			try {
				runs = JSON.parse(event.data) as LiveRun[];
			} catch {
				// Ignore malformed payloads.
			}
		};

		return () => {
			source.close();
		};
	});
</script>

{#if runs.length > 0}
	<div class="mx-2 mb-3 rounded-xl border border-base-300/50 bg-base-200/30 p-2">
		<div class="mb-1.5 flex items-center justify-between px-0.5">
			<p class="text-[10px] font-semibold uppercase tracking-widest opacity-40">Running</p>
			{#if pendingCount > 0}
				<span class="rounded-full bg-warning/25 px-1.5 py-0.5 text-[10px] font-semibold text-warning">
					{pendingCount} pending
				</span>
			{/if}
		</div>

		<div class="space-y-0.5">
			{#each runs.slice(0, 5) as run (run.id)}
				<div class="group/run flex min-w-0 items-center gap-1 rounded-lg pr-1 transition-colors hover:bg-base-200/60">
					<a
						href="/chat/{run.conversationId}"
						class="flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-xs"
					>
						<!-- pulse dot for running state -->
						{#if run.state === 'running'}
							<span class="relative flex size-2 shrink-0">
								<span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60"></span>
								<span class="relative inline-flex size-2 rounded-full bg-success"></span>
							</span>
						{:else}
							<span class="size-2 shrink-0 rounded-full {run.state === 'waiting_tool_approval' || run.state === 'waiting_user_input' ? 'bg-warning' : 'bg-base-300'}"></span>
						{/if}

						<span class="min-w-0 flex-1 truncate opacity-80">
							{run.label?.trim() || 'Chat'}
						</span>

						<span class="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] {stateChipClass(run.state)}">
							{stateLabel(run.state)}
						</span>
					</a>
					<button
						type="button"
						class="shrink-0 rounded-md p-1 opacity-40 hover:bg-error/10 hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-20"
						title="Dismiss this run"
						aria-label="Dismiss run"
						disabled={!!dismissingId}
						onclick={(e) => handleDismiss(e, run.id)}
					>
						<svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
							<line x1="18" y1="6" x2="6" y2="18" />
							<line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</button>
				</div>
			{/each}
		</div>
	</div>
{/if}
