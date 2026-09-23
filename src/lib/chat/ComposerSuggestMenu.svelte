<script lang="ts" module>
	export type SuggestIcon = 'file' | 'folder' | 'terminal' | 'chip' | 'check'

	/** One row of the menu. Generic: `@` files, `/` commands and a command's choices all use it. */
	export type SuggestItem = {
		id: string
		label: string
		/** Positions in `label` to highlight as matched. */
		labelIndices?: readonly number[]
		/** Muted text after the label, such as a command's `<argument>`. */
		hint?: string
		/** A second, smaller line. */
		detail?: string
		detailIndices?: readonly number[]
		icon?: SuggestIcon
		/** A short tag on the right, such as "current" or "on". */
		badge?: string
		disabled?: boolean
	}
</script>

<script lang="ts">
	/**
	 * #22 — the suggestion menu that opens above the composer.
	 *
	 * It never takes focus: the textarea keeps it, and the composer drives the menu from its
	 * own keydown (arrows, Enter, Tab, Escape) and points `aria-activedescendant` at the active
	 * row. A pointer press on a row is `preventDefault`ed so the textarea does not blur, which
	 * is what lets a tap on a phone pick a row instead of closing the menu.
	 */
	import Icon from '$lib/chat-console/Icon.svelte'
	import { highlightSegments } from './mention-match'

	let {
		listId,
		title,
		items,
		activeIndex = 0,
		loading = false,
		emptyText,
		footer = null,
		placement = 'above',
		onPick,
		onHover,
	}: {
		listId: string
		title: string
		items: SuggestItem[]
		activeIndex?: number
		loading?: boolean
		emptyText: string
		footer?: string | null
		placement?: 'above' | 'below'
		onPick: (index: number) => void
		onHover?: (index: number) => void
	} = $props()

	let rootEl: HTMLDivElement | undefined = $state()
	let listEl: HTMLUListElement | undefined = $state()

	// No press inside the menu (a row, the header, the scrollbar) may take focus from the
	// textarea: a blur there closes the menu before the tap lands.
	$effect(() => {
		const el = rootEl
		if (!el) return
		const keepFocus = (event: MouseEvent) => event.preventDefault()
		el.addEventListener('mousedown', keepFocus)
		return () => el.removeEventListener('mousedown', keepFocus)
	})

	$effect(() => {
		const row = listEl?.children[activeIndex] as HTMLElement | undefined
		row?.scrollIntoView({ block: 'nearest' })
	})
</script>

<div bind:this={rootEl} class="console-suggest" class:is-below={placement === 'below'} data-testid="composer-suggest">
	<div class="console-suggest__head">
		<span>{title}</span>
		{#if loading}<span class="loading loading-dots loading-xs" aria-hidden="true"></span>{/if}
	</div>
	{#if items.length > 0}
		<ul bind:this={listEl} id={listId} role="listbox" aria-label={title} class="console-suggest__list">
			{#each items as item, i (item.id)}
				<!-- The keyboard drives these rows from the textarea (aria-activedescendant), which never gives up focus. -->
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<li
					id="{listId}-{i}"
					role="option"
					tabindex="-1"
					aria-selected={i === activeIndex}
					aria-disabled={item.disabled ? 'true' : undefined}
					class="console-suggest__item"
					onmousemove={() => {
						if (i !== activeIndex) onHover?.(i)
					}}
					onclick={() => onPick(i)}
				>
					{#if item.icon}
						<span class="console-suggest__icon"><Icon name={item.icon} size={13} /></span>
					{/if}
					<span class="console-suggest__text">
						<span class="console-suggest__label">
							{#each highlightSegments(item.label, item.labelIndices) as segment, s (s)}{#if segment.match}<mark>{segment.text}</mark>{:else}{segment.text}{/if}{/each}{#if item.hint}<span class="console-suggest__hint">&nbsp;{item.hint}</span>{/if}
						</span>
						{#if item.detail}
							<span class="console-suggest__detail">
								{#each highlightSegments(item.detail, item.detailIndices) as segment, s (s)}{#if segment.match}<mark>{segment.text}</mark>{:else}{segment.text}{/if}{/each}
							</span>
						{/if}
					</span>
					{#if item.badge}<span class="console-suggest__badge">{item.badge}</span>{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<p class="console-suggest__empty" role="status">{loading ? 'Searching…' : emptyText}</p>
	{/if}
	{#if footer}<p class="console-suggest__foot">{footer}</p>{/if}
</div>
