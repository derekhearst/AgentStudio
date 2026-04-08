<script lang="ts">
	type PlannedTool = {
		id: string;
		name: string;
		argumentsText: string;
	};

	let {
		token,
		tools = [],
		status = 'pending',
		onApprove,
		onDeny,
		onContinue,
	}: {
		token: string;
		tools?: PlannedTool[];
		status?: 'pending' | 'approved' | 'denied' | 'continued';
		onApprove?: (token: string) => void | Promise<void>;
		onDeny?: (token: string) => void | Promise<void>;
		onContinue?: (token: string) => void | Promise<void>;
	} = $props();
</script>

<article class="chat chat-start">
	<div class="w-full max-w-3xl rounded-2xl border border-base-300/70 bg-base-100/80 p-4 shadow-sm">
		<div class="mb-3 flex items-start justify-between gap-3">
			<div>
				<p class="text-xs font-semibold uppercase tracking-wide text-primary/80">Execution Plan</p>
				<h3 class="text-sm font-semibold">Review before tool execution</h3>
				<p class="text-xs text-base-content/60">
					{tools.length} planned {tools.length === 1 ? 'tool call' : 'tool calls'}
				</p>
			</div>
			<span class="badge badge-sm {status === 'pending' ? 'badge-warning' : status === 'approved' ? 'badge-success' : status === 'continued' ? 'badge-info' : 'badge-ghost'}">
				{status === 'pending' ? 'Awaiting decision' : status === 'approved' ? 'Approved' : status === 'continued' ? 'Continue planning' : 'Canceled'}
			</span>
		</div>

		<details class="mb-3 rounded-xl border border-base-300/70 bg-base-200/35 px-3 py-2" open>
			<summary class="cursor-pointer text-xs font-medium uppercase tracking-wide text-base-content/60">Plan Details</summary>
			<div class="mt-2 space-y-2">
				{#each tools as tool, idx (tool.id)}
					<div class="rounded-lg border border-base-300/70 bg-base-100/80 px-2 py-2">
						<div class="mb-1 flex items-center gap-2 text-sm">
							<span class="badge badge-outline badge-xs">Step {idx + 1}</span>
							<span class="font-medium">{tool.name}</span>
						</div>
						{#if tool.argumentsText}
							<pre class="max-h-44 overflow-auto rounded-md bg-base-200/60 p-2 text-[11px] leading-relaxed whitespace-pre-wrap">{tool.argumentsText}</pre>
						{/if}
					</div>
				{/each}
			</div>
		</details>

		{#if status === 'pending'}
			<div class="flex flex-wrap justify-end gap-2">
				<button class="btn btn-sm btn-outline" type="button" onclick={() => onContinue?.(token)}>Continue planning</button>
				<button class="btn btn-sm btn-ghost" type="button" onclick={() => onDeny?.(token)}>Cancel plan</button>
				<button class="btn btn-sm btn-primary" type="button" onclick={() => onApprove?.(token)}>Approve & Execute</button>
			</div>
		{/if}
	</div>
</article>
