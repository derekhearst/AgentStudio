<script lang="ts">
	let {
		placeholder = 'Ask DrokBot to do anything...',
		disabled = false,
		onSubmit
	} = $props<{
		placeholder?: string;
		disabled?: boolean;
		onSubmit?: ((value: string) => void) | undefined;
	}>();

	let value = $state('');

	function submitMessage(event: SubmitEvent) {
		event.preventDefault();
		const trimmed = value.trim();
		if (!trimmed) return;
		onSubmit?.(trimmed);
		value = '';
	}
</script>

<form class="flex items-center gap-2 rounded-2xl border border-base-300 bg-base-100 px-3 py-2" onsubmit={submitMessage}>
	<button class="btn btn-sm btn-ghost" type="button" aria-label="Attach file" disabled={disabled}>+</button>
	<input
		type="text"
		class="input input-sm w-full border-none bg-transparent focus:outline-none"
		bind:value
		{placeholder}
		{disabled}
	/>
	<button class="btn btn-sm btn-ghost" type="button" aria-label="Voice input" disabled={disabled}>Mic</button>
	<button class="btn btn-sm btn-primary" type="submit" disabled={disabled || value.trim().length === 0}>Send</button>
</form>
