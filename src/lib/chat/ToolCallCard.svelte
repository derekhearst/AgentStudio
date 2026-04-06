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
		status,
		executionMs = null
	} = $props<{
		name: string;
		argumentsText?: string;
		result?: string;
		status?: 'pending' | 'approved' | 'executing' | 'completed' | 'failed' | 'denied';
		executionMs?: number | null;
	}>();

	const parsedArgs = $derived(parseJsonValue(argumentsText));
	const parsedResult = $derived(parseJsonValue(result));
	const resultText = $derived(result?.trim() ?? '');
	const isStatusFailed = $derived(status === 'failed');
	const isStatusDenied = $derived(status === 'denied');
	const isFailed = $derived(
		isStatusFailed ||
		Boolean(parsedResult && typeof parsedResult === 'object' && 'error' in (parsedResult as Record<string, unknown>)) ||
		/^error:/i.test(resultText)
	);
	const friendlyLabel = $derived(getFriendlyToolLabel(name, parsedArgs, isStatusDenied ? 'denied' : isFailed ? 'failed' : 'completed'));
	const webPreview = $derived(getWebSearchPreview(name, parsedResult));

	const isScreenshot = $derived(name === 'browser_screenshot');

	const colorClass = $derived(
		isFailed
			? 'border-error/60 bg-error/10'
			: name === 'web_search'
			? 'border-info/50 bg-info/10'
			: name.includes('code')
				? 'border-success/50 bg-success/10'
				: name.includes('file')
					? 'border-warning/50 bg-warning/10'
					: 'border-accent/50 bg-accent/10'
	);

	const screenshotSrc = $derived.by(() => {
		if (!isScreenshot || !result) return '';
		try {
			const parsed = JSON.parse(result);
			if (parsed.imageBase64) return `data:image/png;base64,${parsed.imageBase64}`;
		} catch {}
		if (result.startsWith('data:image')) return result;
		return '';
	});
</script>

<details class={`rounded-xl border ${colorClass} transition-all duration-300`}>
	<summary class="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium select-none">
		<div class="flex min-w-0 flex-1 items-center gap-2">
			{#if isStatusDenied || isFailed}
				<svg class="h-4 w-4 shrink-0 text-error" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<circle cx="12" cy="12" r="10" />
					<line x1="15" y1="9" x2="9" y2="15" />
					<line x1="9" y1="9" x2="15" y2="15" />
				</svg>
			{:else}
				<svg class="h-4 w-4 shrink-0 text-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<circle cx="12" cy="12" r="10" />
					<polyline points="16 10 11 15.5 8 12.5" />
				</svg>
			{/if}
			<div class="min-w-0">
				<div class="truncate">{friendlyLabel}</div>
				{#if webPreview}
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
		{#if result}
			{#if screenshotSrc}
				<img src={screenshotSrc} alt="Browser screenshot" class="max-w-full rounded-lg border border-base-300" />
			{:else}
				<pre class="max-h-48 overflow-auto rounded-lg bg-base-100 p-2 text-xs">{result}</pre>
			{/if}
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
