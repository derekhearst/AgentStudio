<script lang="ts">
	import {
		faviconUrl,
		getFriendlyToolLabel,
		getWebSearchPreview,
		parseJsonValue,
	} from './chat';

	let {
		name,
		argumentsText = '',
		result = '',
		status = 'executing',
		failed = false,
		executionMs = null,
		expanded = true,
		token = null,
		onApprove,
		onDeny,
	} = $props<{
		name: string;
		argumentsText?: string;
		result?: string;
		status?: 'pending' | 'approved' | 'executing' | 'completed' | 'denied';
		failed?: boolean;
		executionMs?: number | null;
		expanded?: boolean;
		token?: string | null;
		onApprove?: ((token: string) => void) | undefined;
		onDeny?: ((token: string) => void) | undefined;
	}>();

	const isPending = $derived(status === 'pending');
	const isExecuting = $derived(status === 'executing' || status === 'approved');
	const isCompleted = $derived(status === 'completed');
	const isFailed = $derived(failed);
	const isDenied = $derived(status === 'denied');
	const parsedArgs = $derived(parseJsonValue(argumentsText));
	const parsedResult = $derived(parseJsonValue(result));
	const friendlyLabel = $derived(getFriendlyToolLabel(name, parsedArgs, isFailed ? 'failed' : status));
	const webPreview = $derived(getWebSearchPreview(name, parsedResult));

	const colorClass = $derived(
		isDenied
			? 'border-error/50 bg-error/5'
			: isFailed
				? 'border-error/60 bg-error/10'
			: isPending
				? 'border-warning/50 bg-warning/5'
				: isExecuting
					? 'border-info/50 bg-info/5'
					: name === 'web_search'
						? 'border-info/50 bg-info/10'
						: name.includes('code')
							? 'border-success/50 bg-success/10'
							: name.includes('file')
								? 'border-warning/50 bg-warning/10'
								: 'border-accent/50 bg-accent/10'
	);

	const statusIcon = $derived(
		isDenied ? 'blocked' : isFailed ? 'failed' : isPending ? 'pending' : isExecuting ? 'executing' : 'done'
	);

	const isScreenshot = $derived(name === 'browser_screenshot');
	const screenshotSrc = $derived.by(() => {
		if (!isScreenshot || !result) return '';
		try {
			const parsed = JSON.parse(result);
			if (parsed.imageBase64) return `data:image/png;base64,${parsed.imageBase64}`;
		} catch { /* ignore */ }
		if (result.startsWith('data:image')) return result;
		return '';
	});

</script>

<details class={`tool-call-card rounded-xl border ${colorClass} transition-all duration-300`} open={expanded}>
	<summary class="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium select-none">
		<div class="flex min-w-0 flex-1 items-center gap-2">
			<!-- Status indicator -->
			{#if statusIcon === 'pending'}
				<svg class="h-4 w-4 shrink-0 text-warning" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<circle cx="12" cy="12" r="10" />
					<path d="M12 6v6l4 2" />
				</svg>
			{:else if statusIcon === 'executing'}
				<svg class="h-4 w-4 shrink-0 animate-spin text-info" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
					<path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round" />
				</svg>
			{:else if statusIcon === 'blocked'}
				<svg class="h-4 w-4 shrink-0 text-error" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<circle cx="12" cy="12" r="10" />
					<line x1="15" y1="9" x2="9" y2="15" />
					<line x1="9" y1="9" x2="15" y2="15" />
				</svg>
			{:else if statusIcon === 'failed'}
				<svg class="h-4 w-4 shrink-0 text-error" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<circle cx="12" cy="12" r="10" />
					<line x1="12" y1="7" x2="12" y2="13" />
					<circle cx="12" cy="17" r="1" fill="currentColor" stroke="none" />
				</svg>
			{:else}
				<svg class="h-4 w-4 shrink-0 text-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<circle cx="12" cy="12" r="10" />
					<polyline points="16 10 11 15.5 8 12.5" />
				</svg>
			{/if}

			<div class="min-w-0">
				<div class="truncate">{friendlyLabel}</div>
				{#if webPreview && isCompleted}
					<div class="mt-0.5 flex items-center gap-1.5 text-xs opacity-70">
						<span>{webPreview.count} result{webPreview.count === 1 ? '' : 's'}</span>
						{#each webPreview.hosts as host (host)}
							<img src={faviconUrl(host)} alt={host} title={host} class="h-3.5 w-3.5 rounded-sm" loading="lazy" />
						{/each}
					</div>
				{/if}
			</div>
		</div>

		<div class="ml-2 flex shrink-0 items-center gap-2">
			{#if executionMs !== null}
				<span class="text-xs opacity-50">{executionMs}ms</span>
			{:else if isExecuting}
				<span>
					<svg class="h-3 w-8 opacity-40" viewBox="0 0 40 12">
						<circle cx="6" cy="6" r="2.5" fill="currentColor">
							<animate attributeName="opacity" values="0.3;1;0.3" dur="1s" repeatCount="indefinite" begin="0s" />
						</circle>
						<circle cx="20" cy="6" r="2.5" fill="currentColor">
							<animate attributeName="opacity" values="0.3;1;0.3" dur="1s" repeatCount="indefinite" begin="0.2s" />
						</circle>
						<circle cx="34" cy="6" r="2.5" fill="currentColor">
							<animate attributeName="opacity" values="0.3;1;0.3" dur="1s" repeatCount="indefinite" begin="0.4s" />
						</circle>
					</svg>
				</span>
			{:else if isDenied}
				<span class="text-xs text-error/70">denied</span>
			{:else if isFailed}
				<span class="text-xs text-error/70">failed</span>
			{/if}
			<svg class="tool-chevron h-4 w-4 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<polyline points="6 9 12 15 18 9" />
			</svg>
		</div>
	</summary>

	<div class="space-y-2 px-3 pb-3">
		{#if argumentsText}
			<pre class="overflow-x-auto rounded-lg bg-base-100 p-2 text-xs">{argumentsText}</pre>
		{/if}

		{#if isPending && token}
			<div class="flex items-center gap-2 rounded-lg bg-warning/10 px-3 py-2">
				<span class="text-xs text-warning">Tool wants to execute</span>
				<div class="ml-auto flex gap-1.5">
					<button
						class="btn btn-xs btn-success gap-1"
						type="button"
						onclick={() => onApprove?.(token!)}
					>
						<svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12" /></svg>
						Allow
					</button>
					<button
						class="btn btn-xs btn-error btn-outline gap-1"
						type="button"
						onclick={() => onDeny?.(token!)}
					>
						<svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
						Deny
					</button>
				</div>
			</div>
		{/if}

		{#if result}
			{#if screenshotSrc}
				<img src={screenshotSrc} alt="Browser screenshot" class="max-w-full rounded-lg border border-base-300" />
			{:else}
				<pre class="max-h-48 overflow-auto rounded-lg bg-base-100 p-2 text-xs">{result}</pre>
			{/if}
		{/if}

		{#if isDenied}
			<p class="text-xs text-error/70 italic">Tool execution was denied.</p>
		{:else if isFailed}
			<p class="text-xs text-error/70 italic">Tool execution failed.</p>
		{/if}
	</div>
</details>

<style>
	details .tool-chevron {
		transition: transform 180ms ease;
	}

	details[open] .tool-chevron {
		transform: rotate(180deg);
	}
</style>
