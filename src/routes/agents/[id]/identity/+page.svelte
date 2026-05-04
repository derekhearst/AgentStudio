<svelte:head><title>Edit Identity | AgentStudio</title></svelte:head>

<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import {
		ensureAgentIdentityCommand,
		getAgentIdentityQuery,
		saveAgentIdentityCommand,
		unlinkAgentIdentityCommand,
	} from '$lib/agents';
	import { suggestCompanionsForRole } from '$lib/agents/role-companions';
	import { listFragmentImports } from '$lib/agents/fragment-expand';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';

	type Identity = NonNullable<Awaited<ReturnType<typeof getAgentIdentityQuery>>>;

	const agentId = $derived(page.params.id ?? '');
	let identity = $state<Identity | null>(null);
	let draft = $state('');
	let loading = $state(true);
	let saving = $state(false);
	let saved = $state(false);
	let error = $state<string | null>(null);

	const dirty = $derived(!!identity?.skill && draft !== identity.skill.content);
	const roleSuggestions = $derived(identity ? suggestCompanionsForRole(identity.agent.role) : []);
	const fragmentImports = $derived(listFragmentImports(draft ?? ''));

	async function load() {
		loading = true;
		error = null;
		try {
			identity = await getAgentIdentityQuery(agentId);
			draft = identity?.skill?.content ?? identity?.agent.systemPrompt ?? '';
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load agent';
		} finally {
			loading = false;
		}
	}

	async function ensureSkill() {
		saving = true;
		error = null;
		try {
			identity = await ensureAgentIdentityCommand({ agentId });
			draft = identity?.skill?.content ?? draft;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to create identity skill';
		} finally {
			saving = false;
		}
	}

	async function save() {
		if (!identity?.skill) return;
		saving = true;
		error = null;
		saved = false;
		try {
			identity = await saveAgentIdentityCommand({ agentId, content: draft });
			draft = identity?.skill?.content ?? draft;
			saved = true;
			setTimeout(() => (saved = false), 2500);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to save';
		} finally {
			saving = false;
		}
	}

	async function unlink() {
		if (!confirm('Unlink this identity skill? The agent will fall back to its legacy systemPrompt. The skill itself stays in /skills.')) return;
		saving = true;
		try {
			await unlinkAgentIdentityCommand({ agentId });
			await load();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to unlink';
		} finally {
			saving = false;
		}
	}

	function discard() {
		if (!identity?.skill) return;
		if (dirty && !confirm('Discard unsaved changes?')) return;
		draft = identity.skill.content;
	}

	onMount(load);
</script>

<div class="flex h-full min-h-0 flex-col space-y-3 sm:space-y-4">
	<ContentPanel>
		{#snippet header()}
			<div class="flex flex-1 flex-wrap items-center justify-between gap-2">
				<div>
					<h1 class="text-xl font-bold sm:text-3xl">
						{identity?.agent.name ?? 'Agent'} <span class="opacity-50">— Identity</span>
					</h1>
					<p class="text-xs text-base-content/70 sm:text-sm">
						The identity prompt is the first thing the model reads on every run. Edits land in the linked skill — the next chat picks them up without a redeploy.
					</p>
				</div>
				<div class="flex items-center gap-2">
					<a class="btn btn-sm btn-ghost" href="/agents/{agentId}">← Back to agent</a>
					{#if identity?.skill}
						<a class="btn btn-sm btn-outline" href="/skills/{identity.skill.id}">Open skill</a>
					{/if}
				</div>
			</div>
		{/snippet}

		{#if loading}
			<p class="opacity-70">Loading…</p>
		{:else if !identity}
			<p class="text-error">Agent not found.</p>
		{:else if !identity.skill}
			<div class="rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm">
				<p class="mb-2 font-semibold">No identity skill linked</p>
				<p class="opacity-80">
					Currently this agent uses its legacy <code>systemPrompt</code> column. Promote it to an editable skill so future edits hot-reload without a deploy.
				</p>
				<button class="btn btn-warning btn-sm mt-3" type="button" onclick={ensureSkill} disabled={saving}>
					{saving ? 'Creating…' : 'Promote to skill'}
				</button>
			</div>

			<div class="mt-4">
				<div class="mb-1 text-xs font-semibold uppercase tracking-wider opacity-50">Current prompt (read-only)</div>
				<pre class="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-base-200 p-3 text-sm">{identity.agent.systemPrompt}</pre>
			</div>
		{:else}
			<div class="grid grid-cols-1 gap-3 lg:grid-cols-3">
				<div class="lg:col-span-2 flex flex-col gap-2">
					<div class="flex items-center justify-between">
						<div class="text-xs font-semibold uppercase tracking-wider opacity-50">
							{identity.skill.name}
						</div>
						<div class="flex items-center gap-2 text-xs opacity-70">
							{#if dirty}
								<span class="badge badge-warning badge-sm">unsaved</span>
							{:else if saved}
								<span class="badge badge-success badge-sm">saved</span>
							{:else}
								<span class="badge badge-ghost badge-sm">clean</span>
							{/if}
						</div>
					</div>
					<textarea
						class="textarea textarea-bordered min-h-[28rem] w-full text-sm font-mono leading-relaxed"
						bind:value={draft}
						placeholder="Markdown identity prompt…"
					></textarea>
					<div class="flex flex-wrap items-center gap-2">
						<button class="btn btn-primary btn-sm" type="button" onclick={save} disabled={!dirty || saving}>
							{saving ? 'Saving…' : 'Save'}
						</button>
						<button class="btn btn-ghost btn-sm" type="button" onclick={discard} disabled={!dirty || saving}>
							Discard
						</button>
						<div class="flex-1"></div>
						<button class="btn btn-error btn-outline btn-sm" type="button" onclick={unlink} disabled={saving}>
							Unlink skill
						</button>
					</div>
				</div>

				<aside class="flex flex-col gap-3 text-sm">
					<div class="rounded-lg border border-base-300 bg-base-200 p-3">
						<div class="text-xs font-semibold uppercase tracking-wider opacity-50">Composition order</div>
						<ol class="mt-2 list-decimal pl-4 leading-relaxed opacity-80">
							<li>Identity skill content <span class="opacity-50">(this editor)</span></li>
							<li>Role: <code class="text-xs">{identity.agent.role}</code></li>
							<li>Tool policy (auto)</li>
							<li>Skill summaries (auto)</li>
							<li>Memory recall (auto, when relevant)</li>
						</ol>
					</div>
					<div class="rounded-lg border border-base-300 bg-base-200 p-3">
						<div class="text-xs font-semibold uppercase tracking-wider opacity-50">Tips</div>
						<ul class="mt-2 list-disc pl-4 leading-relaxed opacity-80">
							<li>Keep the identity short. Detailed how-tos belong in companion skills.</li>
							<li>Use <code class="text-xs">@import skill-name</code> on its own line to pull in a reusable fragment skill.</li>
							<li>Edits hot-reload — the next run uses the new content.</li>
						</ul>
					</div>
					{#if roleSuggestions.length > 0}
						<div class="rounded-lg border border-info/40 bg-info/10 p-3">
							<div class="text-xs font-semibold uppercase tracking-wider opacity-70">Recommended for this role</div>
							<p class="mt-1 text-xs opacity-70">
								Based on the agent's role text, these capability groups look natural. Bind them via the agent's Capability Binding section.
							</p>
							<div class="mt-2 flex flex-wrap gap-1">
								{#each roleSuggestions as s}
									<span class="badge badge-info badge-sm" title={`matched: ${s.matchedKeywords.join(', ')}`}>
										{s.group}
									</span>
								{/each}
							</div>
						</div>
					{/if}
					{#if fragmentImports.length > 0}
						<div class="rounded-lg border border-base-300 bg-base-200 p-3">
							<div class="text-xs font-semibold uppercase tracking-wider opacity-50">Detected fragment imports</div>
							<ul class="mt-2 list-disc pl-4 text-xs opacity-80">
								{#each fragmentImports as name}
									<li><code class="text-[11px]">{name}</code></li>
								{/each}
							</ul>
							<p class="mt-2 text-[11px] leading-snug opacity-60">
								These will be expanded inline at run time. A missing or disabled fragment leaves a <code>@import:missing</code> marker visible in the assembled prompt.
							</p>
						</div>
					{/if}
					{#if identity.skill}
						<div class="rounded-lg border border-base-300 bg-base-200 p-3">
							<div class="text-xs font-semibold uppercase tracking-wider opacity-50">Skill metadata</div>
							<dl class="mt-2 text-xs leading-relaxed opacity-80">
								<dt class="font-semibold">Last updated</dt>
								<dd>{new Date(identity.skill.updatedAt).toLocaleString()}</dd>
								<dt class="mt-1 font-semibold">Status</dt>
								<dd>{identity.skill.enabled ? 'enabled' : 'disabled'}</dd>
							</dl>
						</div>
					{/if}
				</aside>
			</div>
		{/if}

		{#if error}
			<div class="alert alert-error mt-4 text-sm">
				<span>{error}</span>
			</div>
		{/if}
	</ContentPanel>
</div>
