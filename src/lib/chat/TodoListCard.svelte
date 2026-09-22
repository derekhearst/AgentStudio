<script lang="ts">
	import type { TodoDetails } from '$lib/engine/tool-result-details';

	/**
	 * #21 — renders a `TodoWrite` as the checklist it is, rather than a JSON array printed
	 * once per update.
	 *
	 * This is the inline form: it shows the list where the update happened. Keeping the
	 * *latest* list pinned above the composer, so a long run stays legible without scrolling
	 * back, is the other half of #21 and a placement decision rather than a rendering one —
	 * the data it needs is already on the block by the time this renders.
	 */

	let { details }: { details: TodoDetails } = $props();

	const done = $derived(details.completed === details.total && details.total > 0);
	const active = $derived(details.items.find((item) => item.status === 'in_progress'));
</script>

<div class={`console-todo ${done ? 'is-done' : ''}`}>
	<div class="console-todo__head">
		<span class="console-todo__title">
			{#if active}
				{active.activeForm ?? active.content}
			{:else if done}
				Plan complete
			{:else}
				Plan
			{/if}
		</span>
		<span class="console-todo__count">{details.completed}/{details.total}</span>
	</div>

	<ul class="console-todo__list">
		{#each details.items as item, idx (`${idx}-${item.content}`)}
			<li class={`console-todo__item is-${item.status}`}>
				<span class="console-todo__mark" aria-hidden="true">
					{#if item.status === 'completed'}✓{:else if item.status === 'in_progress'}▸{:else}·{/if}
				</span>
				<span class="console-todo__text">{item.content}</span>
			</li>
		{/each}
	</ul>

	{#if details.truncated}
		<p class="console-todo__note">Longer list truncated.</p>
	{/if}
</div>
