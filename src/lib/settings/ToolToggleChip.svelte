<script lang="ts">
	let {
		name,
		description,
		checked,
		disabled = false,
		note,
		onchange,
	}: {
		name: string;
		description: string;
		checked: boolean;
		disabled?: boolean;
		/** A short word or two shown after the name, e.g. why the chip is locked. */
		note?: string;
		onchange: (checked: boolean) => void;
	} = $props();
</script>

<label
	class="group flex cursor-pointer items-center justify-between gap-2 rounded-md bg-base-200/40 px-2.5 py-1.5 transition-colors hover:bg-base-200/70 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50"
	title={note ? `${description} (${note})` : description}
>
	<span class="flex min-w-0 items-baseline gap-1.5">
		<span class="truncate font-mono text-xs">{name}</span>
		{#if note}
			<span class="shrink-0 text-[10px] text-base-content/60">{note}</span>
		{/if}
	</span>
	<input
		type="checkbox"
		class="checkbox checkbox-xs checkbox-secondary shrink-0"
		{checked}
		{disabled}
		onchange={(e) => onchange((e.currentTarget as HTMLInputElement).checked)}
	/>
</label>
