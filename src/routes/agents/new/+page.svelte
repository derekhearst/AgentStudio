<svelte:head><title>New Agent | AGENTSTUDIO</title></svelte:head>

<script lang="ts">
	import { goto } from '$app/navigation';
	import { createAgent } from '$lib/agents';
	import ModelSelector from '$lib/models/ModelSelector.svelte';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';

	let name = $state('');
	let role = $state('Research and implementation specialist');
	let model = $state('anthropic/claude-sonnet-4');
	let systemPrompt = $state('You are a focused autonomous coding agent. Produce clear, testable outcomes.');
	let busy = $state(false);
	let error = $state<string | null>(null);

	async function handleSubmit() {
		if (!name.trim() || !role.trim() || !systemPrompt.trim() || busy) return;
		busy = true;
		error = null;
		try {
			const created = await createAgent({
				name: name.trim(),
				role: role.trim(),
				systemPrompt: systemPrompt.trim(),
				model: model.trim(),
			});
			await goto(`/agents/${created.id}`);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Failed to create agent';
		} finally {
			busy = false;
		}
	}
</script>

<section class="space-y-4">
	<a class="btn btn-sm btn-ghost" href="/agents">Back to agents</a>
	<ContentPanel>
		{#snippet header()}
			<div>
				<h1 class="text-3xl font-bold">Create Agent</h1>
				<p class="text-sm text-base-content/70">Define role, model, and operating prompt.</p>
			</div>
		{/snippet}
	</ContentPanel>

	<form
		class="space-y-3 rounded-2xl border border-base-300 bg-base-100 p-4"
		onsubmit={(e) => {
			e.preventDefault();
			void handleSubmit();
		}}
	>
		<label class="form-control">
			<span class="label-text">Name</span>
			<input class="input input-bordered" bind:value={name} placeholder="Ops Architect" />
		</label>
		<label class="form-control">
			<span class="label-text">Role</span>
			<input class="input input-bordered" bind:value={role} />
		</label>
		<div class="form-control">
			<span class="label-text">Model</span>
			<ModelSelector value={model} onchange={(id: string) => (model = id)} />
		</div>
		<label class="form-control">
			<span class="label-text">System prompt</span>
			<textarea class="textarea textarea-bordered h-40" bind:value={systemPrompt}></textarea>
		</label>
		{#if error}
			<p class="text-sm text-error">{error}</p>
		{/if}
		<button class="btn btn-primary" type="submit" disabled={busy}>Create Agent</button>
	</form>
</section>


