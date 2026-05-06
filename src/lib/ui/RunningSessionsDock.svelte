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
				return 'badge badge-success badge-soft badge-xs';
			case 'queued':
				return 'badge badge-ghost badge-xs';
			case 'waiting_tool_approval':
			case 'waiting_user_input':
				return 'badge badge-warning badge-soft badge-xs';
			default:
				return 'badge badge-ghost badge-xs';
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
	<div class="card bg-base-200/30 border-base-300/50 mx-2 mb-3 rounded-xl border p-2">
		<div class="mb-1.5 flex items-center justify-between px-0.5">
			<p class="text-[10px] font-semibold uppercase tracking-widest opacity-40">Running</p>
			{#if pendingCount > 0}
				<span class="badge badge-warning badge-soft badge-xs">
					{pendingCount} pending
				</span>
			{/if}
		</div>

		<div class="space-y-0.5">
			{#each runs.slice(0, 5) as run (run.id)}
				<div
					class="group/run hover:bg-base-200/60 flex min-w-0 items-center gap-1 rounded-lg pr-1 transition-colors"
				>
					<a
						href="/chat/{run.conversationId}"
						class="flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-xs"
					>
						<!-- status indicator -->
						{#if run.state === 'running'}
							<span class="status status-success status-md animate-pulse"></span>
						{:else if run.state === 'waiting_tool_approval' || run.state === 'waiting_user_input'}
							<span class="status status-warning status-md"></span>
						{:else}
							<span class="status status-md"></span>
						{/if}

						<span class="min-w-0 flex-1 truncate opacity-80">
							{run.label?.trim() || 'Chat'}
						</span>

						<span class={stateChipClass(run.state)}>
							{stateLabel(run.state)}
						</span>
					</a>
					<button
						type="button"
						class="btn btn-ghost btn-xs btn-square opacity-40 hover:opacity-100"
						title="Dismiss this run"
						aria-label="Dismiss run"
						disabled={!!dismissingId}
						onclick={(e) => handleDismiss(e, run.id)}
					>
						<i class="mdi mdi-close text-xs" aria-hidden="true"></i>
					</button>
				</div>
			{/each}
		</div>
	</div>
{/if}
