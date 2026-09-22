<script lang="ts">
	import { updateProjectCommand } from '$lib/projects/projects.remote';

	/**
	 * #23 — standing instructions for a project.
	 *
	 * The operator's own words, injected into every run bound to this project through the
	 * project-context slot. Deliberately separate from the trust panel next to it, and not
	 * written out as a `CLAUDE.md`: that file only loads when `settingSources` includes
	 * `'project'`, which trust gates — so routing these through it would make them vanish
	 * for any project whose repo config the operator has not accepted. "Do I trust what this
	 * repo committed" and "here is what I want the agent to know" are different questions.
	 *
	 * A repo's own `CLAUDE.md` still loads on the trusted path. When both exist they compose,
	 * which the hint below says out loud so nobody has to discover it.
	 */

	const MAX = 8000;

	let {
		projectId,
		instructions,
		trusted,
		onChanged
	}: {
		projectId: string;
		instructions: string | null;
		trusted: boolean;
		onChanged?: (next: string | null) => void;
	} = $props();

	/**
	 * The local edit, or null when there isn't one.
	 *
	 * Held separately from the prop rather than seeded from it, so the textarea follows the
	 * project when this component is reused across a navigation — seeding `$state` from a
	 * prop captures only its first value, and the second project would show the first one's
	 * instructions.
	 */
	let edited = $state<string | null>(null);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let saved = $state(false);

	const draft = $derived(edited ?? instructions ?? '');
	const dirty = $derived(draft.trim() !== (instructions ?? '').trim());
	const tooLong = $derived(draft.length > MAX);

	async function save() {
		if (busy || tooLong) return;
		busy = true;
		error = null;
		saved = false;
		try {
			const next = draft.trim().length > 0 ? draft.trim() : null;
			await updateProjectCommand({ projectId, instructions: next });
			onChanged?.(next);
			// Track the prop again: the saved value is now the project's value.
			edited = null;
			saved = true;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not save these instructions';
		} finally {
			busy = false;
		}
	}
</script>

<div class="rounded-lg border border-base-300 bg-base-200/40 p-3">
	<div class="flex flex-wrap items-center gap-2">
		<span class="text-sm font-medium">Project instructions</span>
		{#if instructions}
			<span class="badge badge-sm badge-ghost">in every run</span>
		{/if}
	</div>

	<p class="mt-1.5 text-xs text-base-content/70">
		Markdown, added to the system prompt of every conversation bound to this project. Use it for
		what the agent should always know here — conventions, what to avoid, where things live.
		{#if trusted}
			This project also loads the repo's own <code>CLAUDE.md</code>; the two compose.
		{/if}
	</p>

	<textarea
		class="textarea textarea-bordered mt-2 h-32 w-full font-mono text-xs"
		placeholder="e.g. Always run `bun run check` before saying a change is done."
		value={draft}
		oninput={(event) => {
			edited = event.currentTarget.value;
			saved = false;
		}}
		disabled={busy}
		aria-label="Project instructions"
	></textarea>

	<div class="mt-2 flex flex-wrap items-center gap-2">
		<button class="btn btn-xs" type="button" disabled={busy || !dirty || tooLong} onclick={save}>
			Save instructions
		</button>
		{#if dirty}
			<button
				class="btn btn-xs btn-ghost"
				type="button"
				disabled={busy}
				onclick={() => {
					edited = null;
					saved = false;
				}}
			>
				Revert
			</button>
		{/if}
		<span class={`text-xs ${tooLong ? 'text-error' : 'text-base-content/45'}`}>
			{draft.length}/{MAX}
		</span>
		{#if saved && !dirty}
			<span class="text-xs text-success">Saved</span>
		{/if}
	</div>

	{#if error}
		<p class="mt-1.5 text-xs text-error">{error}</p>
	{/if}
</div>
