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

<aside class="card card-body bg-base-100 border-base-300 rounded-2xl border p-3">
	<h2 class="text-xs font-semibold uppercase tracking-wider opacity-60">Timeline</h2>
	<ul class="timeline timeline-vertical timeline-compact mt-3">
		{#each items as item, idx (item.id)}
			<li>
				{#if idx !== 0}<hr />{/if}
				<div class="timeline-middle">
					<svg
						xmlns="http://www.w3.org/2000/svg"
						viewBox="0 0 20 20"
						fill="currentColor"
						class="text-primary h-4 w-4"
					>
						<path
							fill-rule="evenodd"
							d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
							clip-rule="evenodd"
						/>
					</svg>
				</div>
				<div class="timeline-end timeline-box bg-base-200 border-base-300 ms-1 w-full p-0">
					<button
						class="hover:bg-base-300 w-full px-2 py-1 text-left text-xs"
						type="button"
						onclick={() => onJump?.(item.id)}
					>
						<div class="font-medium">{item.role}</div>
						<div class="opacity-70">{new Date(item.createdAt).toLocaleTimeString()}</div>
					</button>
				</div>
				{#if idx !== items.length - 1}<hr />{/if}
			</li>
		{/each}
	</ul>
</aside>
