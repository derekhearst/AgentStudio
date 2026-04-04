<script lang="ts">
	import ModelSelector from '$lib/components/ui/ModelSelector.svelte';

	let {
		busy = false,
		model = 'anthropic/claude-sonnet-4',
		onSubmit,
		onModelChange,
		estimatedRemaining = 128000
	} = $props<{
		busy?: boolean;
		model?: string;
		onSubmit?: ((content: string) => Promise<void> | void) | undefined;
		onModelChange?: ((model: string) => Promise<void> | void) | undefined;
		estimatedRemaining?: number;
	}>();

	let value = $state('');

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		const trimmed = value.trim();
		if (!trimmed || busy) return;
		await onSubmit?.(trimmed);
		value = '';
	}
</script>

<form class="space-y-2" onsubmit={submit}>
	<div class="flex flex-wrap items-center gap-2 text-xs opacity-70">
		<span>Model</span>
		<ModelSelector
			value={model}
			size="xs"
			class="w-64"
			onchange={(id: string) => onModelChange?.(id)}
		/>
		<span>Estimated remaining: {estimatedRemaining.toLocaleString()} tokens</span>
	</div>

	<div class="flex items-end gap-2 rounded-2xl border border-base-300 bg-base-100 p-2">
		<textarea
			class="textarea w-full border-none bg-transparent focus:outline-none"
			rows="2"
			placeholder="Message DrokBot..."
			bind:value
			disabled={busy}
		></textarea>
		<button class="btn btn-primary" type="submit" disabled={busy || value.trim().length === 0}>
			{busy ? 'Streaming...' : 'Send'}
		</button>
	</div>
</form>
