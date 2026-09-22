<script lang="ts">
	import Icon from '$lib/chat-console/Icon.svelte';
	import type { TodoItem } from '$lib/engine/tool-result-details';

	/**
	 * #21 — the agent's current checklist, pinned above the composer.
	 *
	 * `TodoListCard` already renders a `TodoWrite` where it happened. That is the wrong
	 * place to read a plan *from*: the list scrolls away the moment the model says anything
	 * after it, and a task spanning three turns leaves three of them buried at three
	 * different depths. This shows the latest one, which is what `TodoWrite` means.
	 *
	 * Collapsed by default to a single line — the active item and a count — because the
	 * panel sits in the composer's space and a ten-item plan would push the input off a
	 * phone screen. Expanded state is deliberately not persisted: it is a glance, not a
	 * setting.
	 */

	let {
		items,
		updatedAt,
		onDismiss,
	}: {
		items: TodoItem[];
		updatedAt: string | null;
		onDismiss: () => void;
	} = $props();

	let expanded = $state(false);

	const total = $derived(items.length);
	const completed = $derived(items.filter((item) => item.status === 'completed').length);
	const active = $derived(items.find((item) => item.status === 'in_progress'));
	const done = $derived(total > 0 && completed === total);

	/** What the one collapsed line says. The active item beats a bare count every time. */
	const headline = $derived(
		active ? (active.activeForm ?? active.content) : done ? 'Plan complete' : 'Plan'
	);

	const stamp = $derived.by(() => {
		if (!updatedAt) return '';
		const when = new Date(updatedAt);
		return Number.isNaN(when.getTime()) ? '' : when.toLocaleTimeString();
	});
</script>

{#if total > 0}
	<div class={`pinned-todo ${done ? 'is-done' : ''}`} data-testid="pinned-todo">
		<div class="pinned-todo__bar">
			<button
				type="button"
				class="pinned-todo__toggle"
				aria-expanded={expanded}
				onclick={() => (expanded = !expanded)}
			>
				<span class="pinned-todo__caret"><Icon name="caret" size={11} /></span>
				<span class="pinned-todo__headline">{headline}</span>
			</button>

			<span class="pinned-todo__count" title={stamp ? `Updated ${stamp}` : undefined}>
				{completed}/{total}
			</span>

			<button
				type="button"
				class="pinned-todo__dismiss"
				title="Dismiss this checklist"
				aria-label="Dismiss this checklist"
				onclick={onDismiss}
			>
				<Icon name="x" size={12} />
			</button>
		</div>

		<div
			class="pinned-todo__progress"
			role="progressbar"
			aria-valuenow={completed}
			aria-valuemin={0}
			aria-valuemax={total}
		>
			<span style={`width: ${total > 0 ? Math.round((completed / total) * 100) : 0}%`}></span>
		</div>

		{#if expanded}
			<ul class="pinned-todo__list">
				{#each items as item, idx (`${idx}-${item.content}`)}
					<li class={`pinned-todo__item is-${item.status}`}>
						<span class="pinned-todo__mark" aria-hidden="true">
							{#if item.status === 'completed'}✓{:else if item.status === 'in_progress'}▸{:else}·{/if}
						</span>
						<span class="pinned-todo__text">{item.content}</span>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
{/if}
