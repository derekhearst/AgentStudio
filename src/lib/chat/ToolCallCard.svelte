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
		status = 'completed',
		failed = false,
		executionMs = null,
		expanded,
		token = null,
		onApprove,
		onDeny,
	} = $props<{
		name: string;
		argumentsText?: string;
		result?: string;
		status?: 'pending' | 'approved' | 'executing' | 'completed' | 'failed' | 'denied';
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
	const isDenied = $derived(status === 'denied');
	const parsedArgs = $derived(parseJsonValue(argumentsText));
	const parsedResult = $derived(parseJsonValue(result));
	const resultText = $derived(result?.trim() ?? '');
	const isFailed = $derived(
		failed ||
			status === 'failed' ||
			Boolean(parsedResult && typeof parsedResult === 'object' && 'error' in (parsedResult as Record<string, unknown>)) ||
			/^error:/i.test(resultText),
	);
	const friendlyLabel = $derived(
		getFriendlyToolLabel(name, parsedArgs, isDenied ? 'denied' : isFailed ? 'failed' : status),
	);
	const webPreview = $derived(getWebSearchPreview(name, parsedResult));
	const defaultExpanded = $derived(isPending || isExecuting);
	const isOpen = $derived(expanded ?? defaultExpanded);

	const accentClass = $derived(
		isDenied || isFailed
			? 'border-l-2 border-error/60 pl-1.5'
			: isPending
				? 'border-l-2 border-warning/60 pl-1.5'
				: '',
	);

	const statusIcon = $derived(
		isDenied ? 'blocked' : isFailed ? 'failed' : isPending ? 'pending' : isExecuting ? 'executing' : 'done',
	);

	const isScreenshot = $derived(name === 'browser_screenshot');
	const screenshotSrc = $derived.by(() => {
		if (!isScreenshot || !result) return '';
		try {
			const parsed = JSON.parse(result);
			if (parsed.imageBase64) return `data:image/png;base64,${parsed.imageBase64}`;
		} catch {
			/* ignore */
		}
		if (result.startsWith('data:image')) return result;
		return '';
	});
</script>

<details class={`collapse collapse-arrow tool-call-card rounded-md ${accentClass}`} open={isOpen}>
	<summary class="collapse-title flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm font-normal min-h-0 select-none rounded-md transition-colors hover:bg-base-200/50">
		<div class="flex min-w-0 flex-1 items-center gap-2">
			{#if statusIcon === 'pending'}
				<svg class="h-3.5 w-3.5 shrink-0 text-warning/80" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<circle cx="12" cy="12" r="10" />
					<path d="M12 6v6l4 2" />
				</svg>
			{:else if statusIcon === 'executing'}
				<svg class="h-3.5 w-3.5 shrink-0 animate-spin text-info/80" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
					<path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round" />
				</svg>
			{:else if statusIcon === 'blocked'}
				<svg class="h-3.5 w-3.5 shrink-0 text-error/80" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<circle cx="12" cy="12" r="10" />
					<line x1="15" y1="9" x2="9" y2="15" />
					<line x1="9" y1="9" x2="15" y2="15" />
				</svg>
			{:else if statusIcon === 'failed'}
				<svg class="h-3.5 w-3.5 shrink-0 text-error/80" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<circle cx="12" cy="12" r="10" />
					<line x1="12" y1="7" x2="12" y2="13" />
					<circle cx="12" cy="17" r="1" fill="currentColor" stroke="none" />
				</svg>
			{:else}
				<svg class="h-3.5 w-3.5 shrink-0 text-base-content/45" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<polyline points="20 6 9 17 4 12" />
				</svg>
			{/if}

			<span class="truncate text-base-content/80">{friendlyLabel}</span>

			{#if webPreview && (isCompleted || !isExecuting)}
				<span class="flex shrink-0 items-center gap-1 text-xs text-base-content/45">
					<span>·</span>
					<span>{webPreview.count} result{webPreview.count === 1 ? '' : 's'}</span>
					{#each webPreview.hosts as host (host)}
						<img src={faviconUrl(host)} alt={host} title={host} class="h-3 w-3 rounded-sm" loading="lazy" />
					{/each}
				</span>
			{/if}
		</div>

		<div class="ml-2 flex shrink-0 items-center gap-2">
			{#if executionMs !== null}
				<span class="text-[11px] text-base-content/40">{executionMs}ms</span>
			{:else if isExecuting}
				<span>
					<svg class="h-3 w-7 text-base-content/40" viewBox="0 0 40 12">
						<circle cx="6" cy="6" r="2" fill="currentColor">
							<animate attributeName="opacity" values="0.3;1;0.3" dur="1s" repeatCount="indefinite" begin="0s" />
						</circle>
						<circle cx="20" cy="6" r="2" fill="currentColor">
							<animate attributeName="opacity" values="0.3;1;0.3" dur="1s" repeatCount="indefinite" begin="0.2s" />
						</circle>
						<circle cx="34" cy="6" r="2" fill="currentColor">
							<animate attributeName="opacity" values="0.3;1;0.3" dur="1s" repeatCount="indefinite" begin="0.4s" />
						</circle>
					</svg>
				</span>
			{:else if isDenied}
				<span class="text-[11px] text-error/70">denied</span>
			{:else if isFailed}
				<span class="text-[11px] text-error/70">failed</span>
			{/if}
		</div>
	</summary>

	<div class="collapse-content space-y-2 px-2 pb-2 text-sm">
		{#if argumentsText}
			<pre class="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-base-200/40 p-2 text-[11px] tablet:text-xs">{argumentsText}</pre>
		{/if}

		{#if isPending && token}
			<div class="flex items-center gap-2 rounded-md bg-warning/10 px-3 py-2">
				<span class="text-xs text-warning">Tool wants to execute</span>
				<div class="ml-auto flex gap-1.5">
					<button class="btn btn-xs btn-success gap-1" type="button" onclick={() => onApprove?.(token!)}>
						<svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12" /></svg>
						Allow
					</button>
					<button class="btn btn-xs btn-error btn-outline gap-1" type="button" onclick={() => onDeny?.(token!)}>
						<svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
						Deny
					</button>
				</div>
			</div>
		{/if}

		{#if result}
			{#if screenshotSrc}
				<img src={screenshotSrc} alt="Browser screenshot" class="max-w-full rounded-md border border-base-300/60" />
			{:else}
				<pre class="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-base-200/40 p-2 text-[11px] tablet:text-xs">{result}</pre>
			{/if}
		{/if}

		{#if isDenied}
			<p class="text-xs text-error/70 italic">Tool execution was denied.</p>
		{:else if isFailed && (status === 'failed' || failed)}
			<p class="text-xs text-error/70 italic">Tool execution failed.</p>
		{/if}
	</div>
</details>

