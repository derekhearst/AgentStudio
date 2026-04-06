<script lang="ts">
	type Item = {
		id: string;
		role: string;
		createdAt: Date | string;
	};

	let {
		items,
		onJump
	} = $props<{
		items: Item[];
		onJump?: ((messageId: string) => Promise<void> | void) | undefined;
	}>();
</script>

<aside class="rounded-2xl border border-base-300 bg-base-100 p-3">
	<h2 class="text-xs font-semibold uppercase tracking-wider opacity-60">Timeline</h2>
	<ul class="mt-3 space-y-2">
		{#each items as item (item.id)}
			<li>
				<button class="w-full rounded-lg border border-base-300 px-2 py-1 text-left text-xs hover:bg-base-200" type="button" onclick={() => onJump?.(item.id)}>
					<div class="font-medium">{item.role}</div>
					<div class="opacity-70">{new Date(item.createdAt).toLocaleTimeString()}</div>
				</button>
			</li>
		{/each}
	</ul>
</aside>
