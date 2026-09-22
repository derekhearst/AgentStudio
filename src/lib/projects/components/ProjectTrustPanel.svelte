<script lang="ts">
	import { updateProjectCommand } from '$lib/projects/projects.remote';

	/**
	 * #23 — whether this project's committed `.claude/` configuration loads.
	 *
	 * Trusting is what makes an imported repo behave for our agent the way it does for its
	 * own contributors: its `CLAUDE.md`, its `.claude/commands/`, its `.claude/skills/`.
	 * The same switch also loads its `.claude/settings.json`, which can carry hooks and
	 * permission allow-rules — the SDK gives one `settingSources` tier for all of it, so
	 * the two cannot be separated and the copy here does not pretend otherwise.
	 *
	 * Enabling takes a second click. Disabling does not: making the safer direction slower
	 * than the riskier one is how a safety control becomes an annoyance people route around.
	 */

	let {
		projectId,
		repoKind,
		trusted,
		onChanged
	}: {
		projectId: string;
		repoKind: string;
		trusted: boolean;
		onChanged?: (next: boolean) => void;
	} = $props();

	let busy = $state(false);
	let confirming = $state(false);
	let error = $state<string | null>(null);

	const hasRepo = $derived(repoKind !== 'none');

	async function setTrusted(next: boolean) {
		if (busy) return;
		busy = true;
		error = null;
		try {
			await updateProjectCommand({ projectId, settingsTrusted: next });
			confirming = false;
			onChanged?.(next);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not change project trust';
		} finally {
			busy = false;
		}
	}
</script>

<div class="rounded-lg border border-base-300 bg-base-200/40 p-3">
	<div class="flex flex-wrap items-center gap-2">
		<span class="text-sm font-medium">Project configuration</span>
		{#if trusted}
			<span class="badge badge-sm badge-warning">trusted</span>
		{:else}
			<span class="badge badge-sm badge-ghost">not loaded</span>
		{/if}
	</div>

	{#if !hasRepo}
		<p class="mt-1.5 text-xs text-base-content/60">
			This project has no repository, so there is no committed <code>.claude/</code> configuration
			to load.
		</p>
	{:else}
		<p class="mt-1.5 text-xs text-base-content/70">
			{#if trusted}
				Runs in this project load its <code>CLAUDE.md</code>, <code>.claude/commands/</code> and
				<code>.claude/skills/</code> — and its <code>.claude/settings.json</code>, which can define
				hooks and permission rules.
			{:else}
				Runs ignore everything in this project's <code>.claude/</code> directory. Trust it to pick
				up the repo's own instructions, commands and skills.
			{/if}
		</p>

		{#if !trusted}
			<p class="mt-1.5 text-xs text-warning/90">
				Only trust a repository whose <code>.claude/</code> contents you have read. Trusting it lets
				the repo define hooks, which run commands, and permission rules, which decide what the agent
				may do without asking you.
			</p>
		{/if}

		{#if error}
			<p class="mt-1.5 text-xs text-error">{error}</p>
		{/if}

		<div class="mt-2 flex flex-wrap items-center gap-2">
			{#if trusted}
				<button class="btn btn-xs" type="button" disabled={busy} onclick={() => setTrusted(false)}>
					Stop loading it
				</button>
			{:else if confirming}
				<button
					class="btn btn-xs btn-warning"
					type="button"
					disabled={busy}
					onclick={() => setTrusted(true)}
				>
					Yes, load this repo's configuration
				</button>
				<button class="btn btn-xs btn-ghost" type="button" disabled={busy} onclick={() => (confirming = false)}>
					Cancel
				</button>
			{:else}
				<button class="btn btn-xs" type="button" disabled={busy} onclick={() => (confirming = true)}>
					Trust this project's configuration
				</button>
			{/if}
		</div>
	{/if}
</div>
