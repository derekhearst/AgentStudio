<script lang="ts">
	import Icon from '$lib/chat-console/Icon.svelte';
	import type { ShellDetails } from '$lib/engine/tool-result-details';

	/**
	 * #26 — renders a `Bash` call as a terminal rather than a JSON-escaped string.
	 *
	 * stdout and stderr arrive already separated and already capped by
	 * `$lib/engine/tool-result-details`; nothing here parses the result text. ANSI escapes
	 * are stripped rather than rendered — the value is readable output, and half-supported
	 * colour is worse than none.
	 *
	 * A backgrounded command shows its task id instead of pretending to be finished. The
	 * live-updating version of that (polling `BashOutput`, a kill button) belongs to #35;
	 * this card is the surface it will fill.
	 */

	let {
		details,
		success = true,
		expanded
	}: {
		details: ShellDetails;
		success?: boolean;
		expanded?: boolean;
	} = $props();

	/** Strip ANSI escapes rather than render them: half-supported colour reads worse than none. */
	const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

	const stdout = $derived(details.stdout.replace(ANSI, ''));
	const stderr = $derived(details.stderr.replace(ANSI, ''));

	const totalLines = $derived(
		(stdout ? stdout.split('\n').length : 0) + (stderr ? stderr.split('\n').length : 0)
	);
	const hasOutput = $derived(Boolean(stdout.trim() || stderr.trim()));
	const isBackground = $derived(Boolean(details.backgroundTaskId));

	/** Fold long output; a short command's output is the whole point of the card. */
	const defaultExpanded = $derived(hasOutput && totalLines <= 20);
	const isOpen = $derived(expanded ?? (defaultExpanded || isBackground));

	const accentClass = $derived(
		!success || details.interrupted ? 'console-tool err' : isBackground ? 'console-tool warn' : 'console-tool ok'
	);

	const label = $derived(details.command ?? details.description ?? details.tool);

	let copied = $state(false);

	async function copyOutput() {
		const payload = [stdout, stderr].filter((part) => part.trim()).join('\n');
		try {
			await navigator.clipboard.writeText(payload);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			// Clipboard access can be refused (insecure origin, denied permission). The output
			// is selectable either way, so a failed copy is not worth an error state.
		}
	}
</script>

<details class={`tool-call-card console-term ${accentClass}`} open={isOpen}>
	<summary class="select-none transition-colors hover:bg-base-200/50">
		<div class="flex min-w-0 flex-1 items-center gap-2">
			<Icon name="terminal" size={13} />
			<span class="console-term__cmd" title={label}>
				<span class="console-term__prompt">$</span>
				{label}
			</span>
		</div>

		<div class="ml-2 flex shrink-0 items-center gap-2">
			{#if isBackground}
				<span class="console-term__badge is-bg">background</span>
			{/if}
			{#if details.timedOutAfterMs !== null}
				<span class="console-term__badge is-warn">timed out</span>
			{/if}
			{#if details.interrupted}
				<span class="console-term__badge is-err">interrupted</span>
			{:else if !success}
				<span class="console-term__badge is-err">failed</span>
			{/if}
		</div>
	</summary>

	<div class="collapse-content">
		{#if details.command && details.description}
			<p class="console-term__desc">{details.description}</p>
		{/if}

		{#if hasOutput}
			<div class="console-term__body">
				{#if details.truncated}
					<div class="console-term__note">Earlier output trimmed — showing the tail.</div>
				{/if}
				{#if stdout.trim()}
					<pre class="console-term__out">{stdout}</pre>
				{/if}
				{#if stderr.trim()}
					<pre class="console-term__out is-err">{stderr}</pre>
				{/if}
			</div>

			<div class="flex flex-wrap items-center gap-2">
				<button type="button" class="console-prev-chip" onclick={copyOutput}>
					<Icon name={copied ? 'check' : 'copy'} size={10} />
					<span>{copied ? 'Copied' : 'Copy output'}</span>
				</button>
				{#if details.persistedOutputPath}
					<span class="console-term__note">Full output: {details.persistedOutputPath}</span>
				{/if}
			</div>
		{:else if isBackground}
			<p class="console-term__note">
				Running in the background as <code>{details.backgroundTaskId}</code>. Output arrives when
				the agent checks on it.
			</p>
		{:else}
			<p class="console-term__note">Command produced no output.</p>
		{/if}
	</div>
</details>
