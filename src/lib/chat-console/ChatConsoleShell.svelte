<script lang="ts">
	import type { Snippet } from 'svelte';
	import ChatConsoleSidebar from './ChatConsoleSidebar.svelte';
	import ChatConsoleRail from './ChatConsoleRail.svelte';
	import MobileLeftDrawer from './MobileLeftDrawer.svelte';
	import MobileRightDrawer from './MobileRightDrawer.svelte';
	import { previewState } from './preview-state.svelte';
	import { useResizableSize } from './use-resize.svelte';

	let {
		activePath = '/',
		showRail = false,
		children,
	}: { activePath?: string; showRail?: boolean; children: Snippet } = $props();

	/** #14 — width of the collapsed rail: room for one column of icon buttons. */
	const RAIL_STRIP_W = 40;

	const sidebarSize = useResizableSize('console:sb-w', 220, 180, 360);
	const railSize = useResizableSize('console:rail-w', 360, 240, 520);
	const railOpen = $derived(previewState.open);
	const railWidth = $derived(showRail ? (railOpen ? railSize.value : RAIL_STRIP_W) : 0);
</script>

<div class="console-shell">
	<div
		class="console-grid {showRail ? 'has-rail' : ''}"
		style="--c-sb-w:{sidebarSize.value}px; --c-rail-w:{railWidth}px;"
	>
		<button
			type="button"
			class="console-resize console-resize--sb"
			aria-label="Resize sidebar"
			onmousedown={(e) => sidebarSize.startDrag(e, 'x', 1)}
		>
			<span class="console-resize__grip"></span>
		</button>

		{#if showRail && railOpen}
			<button
				type="button"
				class="console-resize console-resize--rail"
				aria-label="Resize right rail"
				onmousedown={(e) => railSize.startDrag(e, 'x', -1)}
			>
				<span class="console-resize__grip"></span>
			</button>
		{/if}

		<ChatConsoleSidebar {activePath} />

		<main class="console-main">
			<div class="console-main__inner">
				{@render children()}
			</div>
		</main>

		{#if showRail}
			<ChatConsoleRail />
		{/if}
	</div>
</div>

<MobileLeftDrawer {activePath} />
{#if showRail}
	<MobileRightDrawer />
{/if}
