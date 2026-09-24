<script lang="ts">
	import Icon from '$lib/chat-console/Icon.svelte';
	import { cleanTerminalText, tailLines } from '$lib/chat/terminal-text';
	import { MAX_STREAM_CHARS, type ShellDetails } from '$lib/engine/tool-result-details';

	/**
	 * #26 — renders a `Bash` call as a terminal rather than a JSON-escaped string.
	 *
	 * stdout and stderr arrive already separated and already capped by
	 * `$lib/engine/tool-result-details`; nothing here parses the result text. Escapes are
	 * stripped rather than rendered (`$lib/chat/terminal-text`), and a long output shows its
	 * last lines with a control to show the rest — the end is where a command says how it went.
	 *
	 * #35 — a backgrounded command is live while its turn runs: the engine tails the CLI's
	 * output file and the chat grows `details.stdout` from `shell_output` frames (and, on a
	 * page that reconnected mid-turn, from the `shell_output_checkpoint` saved every few
	 * seconds — see `applyShellOutput`). The card
	 * follows the newest output unless the reader has scrolled up, and says how the command
	 * ended — including "ended with turn" for one still running when the reply finished, since
	 * background commands do not outlive their turn. A block saved before this existed has no
	 * `background` field and renders as it always did.
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

	/** Lines shown before "Show all". */
	const PREVIEW_LINES = 20;

	/*
	 * A stream at the cap was cut to its tail at an arbitrary character, so its first line is a
	 * fragment (`truncated` alone covers both streams, so the length says which one it was).
	 */
	const clipped = (text: string) => details.truncated && text.length >= MAX_STREAM_CHARS;
	const stdout = $derived(cleanTerminalText(details.stdout, { clipped: clipped(details.stdout) }));
	const stderr = $derived(cleanTerminalText(details.stderr, { clipped: clipped(details.stderr) }));

	let showAll = $state(false);
	const stdoutTail = $derived(tailLines(stdout, PREVIEW_LINES));
	const stderrTail = $derived(tailLines(stderr, PREVIEW_LINES));
	const totalLines = $derived(stdoutTail.total + stderrTail.total);
	const canCollapse = $derived(stdoutTail.hidden > 0 || stderrTail.hidden > 0);
	const shownStdout = $derived(showAll ? stdout : stdoutTail.shown);
	const shownStderr = $derived(showAll ? stderr : stderrTail.shown);

	const hasOutput = $derived(Boolean(stdout.trim() || stderr.trim()));
	const isBackground = $derived(Boolean(details.backgroundTaskId));
	const status = $derived(details.background?.status ?? null);
	const live = $derived(status === 'running');
	const exitCode = $derived(typeof details.exitCode === 'number' ? details.exitCode : null);

	const isOpen = $derived(
		expanded ?? (hasOutput || isBackground || !success || Boolean(details.returnCodeInterpretation))
	);

	/** One badge, so a long command keeps its room on a phone. */
	const badge = $derived.by((): { text: string; tone: 'ok' | 'warn' | 'err' | 'bg' | 'live' } | null => {
		if (details.interrupted) return { text: 'interrupted', tone: 'err' };
		if (status === 'running') return { text: 'live', tone: 'live' };
		if (status === 'completed' || status === 'failed') {
			if (exitCode !== null) return { text: `exit ${exitCode}`, tone: exitCode === 0 ? 'ok' : 'err' };
			return status === 'completed' ? { text: 'finished', tone: 'ok' } : { text: 'failed', tone: 'err' };
		}
		if (status === 'stopped') return { text: 'stopped', tone: 'warn' };
		if (status === 'ended_with_turn') return { text: 'ended with turn', tone: 'warn' };
		if (isBackground) return { text: details.timedOutAfterMs !== null ? 'timed out' : 'background', tone: 'bg' };
		if (exitCode !== null) return { text: `exit ${exitCode}`, tone: exitCode === 0 ? 'ok' : 'err' };
		if (!success) return { text: 'failed', tone: 'err' };
		return null;
	});

	const failed = $derived(
		!success || details.interrupted || status === 'failed' || (exitCode !== null && exitCode !== 0)
	);
	const accentClass = $derived(
		failed ? 'console-tool err' : isBackground && status !== 'completed' ? 'console-tool warn' : 'console-tool ok'
	);

	const label = $derived(details.command ?? details.description ?? details.tool);

	/*
	 * Follow the newest output while the command is live — unless the reader scrolled up to
	 * look at something, which a jump back to the bottom every second would take away.
	 */
	let body = $state<HTMLDivElement | null>(null);
	let following = $state(true);

	function onBodyScroll() {
		if (!body) return;
		following = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
	}

	$effect(() => {
		void stdout.length;
		void stderr.length;
		if (!live || !following || !body) return;
		body.scrollTop = body.scrollHeight;
	});

	let copied = $state(false);

	async function copyOutput() {
		// The whole output, not the preview.
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

<details
	class={`tool-call-card console-term ${accentClass}`}
	open={isOpen}
	data-testid="shell-output-card"
	data-status={status ?? (isBackground ? 'background' : 'foreground')}
>
	<summary class="select-none transition-colors hover:bg-base-200/50">
		<div class="flex min-w-0 flex-1 items-center gap-2">
			<Icon name="terminal" size={13} />
			<span class="console-term__cmd" title={label}>
				<span class="console-term__prompt">$</span>
				{label}
			</span>
		</div>

		{#if badge}
			<div class="ml-2 flex shrink-0 items-center gap-2">
				<span class={`console-term__badge is-${badge.tone}`}>
					{#if badge.tone === 'live'}<span class="console-term__pulse" aria-hidden="true"></span>{/if}
					{badge.text}
				</span>
			</div>
		{/if}
	</summary>

	<div class="collapse-content">
		{#if details.command && details.description}
			<p class="console-term__desc">{details.description}</p>
		{/if}

		{#if hasOutput}
			<div class="console-term__body" bind:this={body} onscroll={onBodyScroll}>
				{#if details.truncated}
					<div class="console-term__note">Earlier output trimmed — showing the tail.</div>
				{/if}
				{#if canCollapse && !showAll}
					<div class="console-term__note">
						{stdoutTail.hidden + stderrTail.hidden} earlier {stdoutTail.hidden + stderrTail.hidden === 1
							? 'line'
							: 'lines'} hidden.
					</div>
				{/if}
				{#if stdout.trim()}
					<pre class="console-term__out">{shownStdout}</pre>
				{/if}
				{#if stderr.trim()}
					<pre class="console-term__out is-err">{shownStderr}</pre>
				{/if}
			</div>

			<div class="flex flex-wrap items-center gap-2">
				{#if canCollapse}
					<button
						type="button"
						class="console-prev-chip"
						aria-expanded={showAll}
						onclick={() => (showAll = !showAll)}
					>
						<span>{showAll ? `Show last ${PREVIEW_LINES} lines` : `Show all ${totalLines} lines`}</span>
					</button>
				{/if}
				<button type="button" class="console-prev-chip" onclick={copyOutput}>
					<Icon name={copied ? 'check' : 'copy'} size={10} />
					<span>{copied ? 'Copied' : 'Copy output'}</span>
				</button>
				{#if details.persistedOutputPath}
					<span class="console-term__note">Full output: {details.persistedOutputPath}</span>
				{/if}
			</div>
		{:else if live}
			<p class="console-term__note">
				Running in the background as <code>{details.backgroundTaskId}</code>. Its output appears
				here as it arrives.
			</p>
		{:else if isBackground && status}
			<p class="console-term__note">The command printed nothing.</p>
		{:else if isBackground}
			<p class="console-term__note">
				Ran in the background as <code>{details.backgroundTaskId}</code>. Its output was not
				captured here.
			</p>
		{:else if !details.returnCodeInterpretation}
			<p class="console-term__note">Command produced no output.</p>
		{/if}

		{#if details.returnCodeInterpretation}
			<p class="console-term__note">{details.returnCodeInterpretation}</p>
		{/if}
		{#if status === 'ended_with_turn'}
			<p class="console-term__note">
				Stopped when the turn ended — background commands only run until the reply is finished.
			</p>
		{:else if isBackground && details.timedOutAfterMs !== null}
			<p class="console-term__note">
				Moved to the background after its {Math.max(1, Math.round(details.timedOutAfterMs / 1000))}s
				timeout.
			</p>
		{/if}
	</div>
</details>
