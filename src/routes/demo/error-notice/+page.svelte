<svelte:head><title>Error notice preview</title></svelte:head>

<script lang="ts">
	/**
	 * Visual harness for ChatErrorNotice. `/demo` is already public (see
	 * PUBLIC_PATH_PREFIXES in src/lib/auth/gate.ts), so the notice can be eyeballed in every
	 * cause and both themes without driving a real failing run.
	 */
	import ChatErrorNotice from '$lib/chat/ChatErrorNotice.svelte';

	const cases = [
		'Run failed',
		'Stream interrupted',
		'Tool call was denied by the operator',
		'Daily budget limit reached ($5.00)',
		'Model "kimi-2.6" needs an Anthropic-compatible gateway, but LLM_GATEWAY_URL is not set.',
		'ECONNRESET reading from upstream after 30s',
	];
</script>

<div class="mx-auto max-w-3xl space-y-4 p-6">
	<h1 class="text-lg font-semibold">ChatErrorNotice — every cause</h1>
	{#each cases as message (message)}
		<ChatErrorNotice {message} canRetry onRetry={() => {}} onDismiss={() => {}} />
	{/each}

	<h2 class="pt-4 text-sm font-semibold opacity-70">Without a retry action</h2>
	<ChatErrorNotice message="Run failed" onDismiss={() => {}} />

	<h2 class="pt-4 text-sm font-semibold opacity-70">Mid-retry</h2>
	<ChatErrorNotice message="Stream interrupted" canRetry retrying busy onRetry={() => {}} onDismiss={() => {}} />
</div>
