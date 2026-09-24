<script lang="ts">
	import { MediaQuery } from 'svelte/reactivity';
	import { mobileDrawerState } from './mobile-drawer-state.svelte';
	import { previewState, toggleRailFromHeader } from './preview-state.svelte';

	/*
	 * #14 — the chat header's rail button, shown below the desktop breakpoint.
	 *
	 * It does two different things, and its name and `aria-expanded` follow whichever it does
	 * at the current width: on a phone it opens the rail's drawer; on a tablet, where the rail
	 * is a column beside the thread, it expands or folds that column. Same query as
	 * `isDrawerViewport` in preview-state, so the label never disagrees with the action.
	 */
	const drawerViewport = new MediaQuery('(max-width: 47.99rem)');

	const expanded = $derived(drawerViewport.current ? mobileDrawerState.right : previewState.open);
	const label = $derived(
		drawerViewport.current ? 'Open chat rail' : previewState.open ? 'Collapse chat rail' : 'Expand chat rail'
	);
</script>

<button
	type="button"
	onclick={toggleRailFromHeader}
	class="console-iconbtn"
	aria-label={label}
	aria-expanded={expanded}
	title={label}
	style="width:32px;height:32px;border:1px solid var(--color-base-300);"
>
	<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<rect x="3" y="4" width="18" height="16" rx="2" />
		<line x1="15" y1="4" x2="15" y2="20" />
	</svg>
</button>
