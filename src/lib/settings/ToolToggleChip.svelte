<script lang="ts">
	let {
		name,
		description,
		checked,
		disabled = false,
		onchange,
	}: {
		name: string;
		description: string;
		checked: boolean;
		disabled?: boolean;
		onchange: (checked: boolean) => void;
	} = $props();
</script>

<label
	class="group flex cursor-pointer items-center justify-between gap-2 rounded-md bg-base-200/40 px-2.5 py-1.5 transition-colors hover:bg-base-200/70 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50"
	title={description}
>
	<span class="truncate font-mono text-xs">{name}</span>
	<input
		type="checkbox"
		class="checkbox checkbox-xs checkbox-secondary shrink-0"
		{checked}
		{disabled}
		onchange={(e) => onchange((e.currentTarget as HTMLInputElement).checked)}
	/>
</label>
