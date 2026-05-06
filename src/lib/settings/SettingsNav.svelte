<script lang="ts">
	type Section = {
		id: string;
		label: string;
		color: string;
	};

	let {
		sections,
		activeId,
		isVisible,
		onnavigate,
	}: {
		sections: readonly Section[];
		activeId: string;
		isVisible: (id: string) => boolean;
		onnavigate: (id: string) => void;
	} = $props();
</script>

<nav class="hidden lg:sticky lg:top-2 lg:block lg:self-start" aria-label="Settings sections">
	<ul class="flex flex-col gap-0.5 text-sm">
		{#each sections as s (s.id)}
			{@const active = activeId === s.id}
			{@const dim = !isVisible(s.id)}
			<li>
				<a
					href="#sec-{s.id}"
					class="flex items-center gap-2 rounded-md px-2.5 py-1.5 transition-colors hover:bg-base-200/70 {active
						? 'bg-base-200 font-medium text-base-content'
						: 'text-base-content/70'} {dim ? 'opacity-40' : ''}"
					onclick={(e) => {
						e.preventDefault();
						onnavigate(s.id);
					}}
				>
					<span class="h-1.5 w-1.5 rounded-full bg-{s.color}"></span>
					<span class="truncate">{s.label}</span>
				</a>
			</li>
		{/each}
	</ul>
</nav>
