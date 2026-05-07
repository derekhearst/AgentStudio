<script lang="ts">
	import { artifactDrawer, ARTIFACT_DRAWER_MIN_PCT, ARTIFACT_DRAWER_MAX_PCT } from './artifact-drawer.svelte';
	import ResearchArtifactView from './ResearchArtifactView.svelte';
	import DocumentArtifactView from './DocumentArtifactView.svelte';
	import ImageArtifactView from './ImageArtifactView.svelte';

	function closeDrawer() {
		artifactDrawer.close();
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && artifactDrawer.isOpen) closeDrawer();
	}

	// ── Desktop resize handle ──────────────────────────────────────────────────────
	let resizing = $state(false);

	function onResizeStart(event: PointerEvent) {
		event.preventDefault();
		resizing = true;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	function onResizeMove(event: PointerEvent) {
		if (!resizing) return;
		const pct = 100 - (event.clientX / window.innerWidth) * 100;
		artifactDrawer.setWidthPct(pct);
	}

	function onResizeEnd(event: PointerEvent) {
		if (!resizing) return;
		resizing = false;
		(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
	}

	function onResizeKey(event: KeyboardEvent) {
		const STEP = 2;
		if (event.key === 'ArrowLeft') {
			event.preventDefault();
			artifactDrawer.setWidthPct(artifactDrawer.widthPct + STEP);
		} else if (event.key === 'ArrowRight') {
			event.preventDefault();
			artifactDrawer.setWidthPct(artifactDrawer.widthPct - STEP);
		}
	}

	// ── Mobile drag-to-dismiss ─────────────────────────────────────────────────────
	let dragY = $state(0);
	let dragging = $state(false);
	let startY = 0;
	let scrollEl: HTMLDivElement | undefined = $state(undefined);

	function onTouchStart(e: TouchEvent) {
		if (scrollEl && scrollEl.scrollTop > 0) return;
		startY = e.touches[0].clientY;
		dragging = false;
		dragY = 0;
	}

	function onTouchMove(e: TouchEvent) {
		const currentY = e.touches[0].clientY;
		const delta = currentY - startY;
		if (delta > 0 && scrollEl && scrollEl.scrollTop <= 0) {
			dragging = true;
			dragY = delta;
			e.preventDefault();
		} else if (!dragging) {
			return;
		}
	}

	function onTouchEnd() {
		if (dragging && dragY > 100) closeDrawer();
		dragY = 0;
		dragging = false;
	}

	const mobilePanelTransform = $derived.by(() => {
		if (!artifactDrawer.isOpen) return 'translateY(100%)';
		if (dragging && dragY > 0) return `translateY(${dragY}px)`;
		return 'translateY(0)';
	});

	const mobilePanelTransition = $derived(dragging ? 'none' : 'transform 200ms ease-out');

	const headerTitle = $derived.by(() => {
		const t = artifactDrawer.target;
		if (!t) return '';
		if (t.kind === 'research') return 'Research';
		if (t.kind === 'document') return 'Document';
		if (t.kind === 'image') return 'Image';
		return '';
	});
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- Desktop: inline second-column panel. Lives inside the layout grid; widthPct
     is applied to the parent grid via a CSS variable. -->
<aside
	class="relative hidden h-full overflow-hidden rounded-3xl border border-base-300 bg-base-100 shadow-sm desktop:flex"
	class:opacity-50={resizing}
>
	{#if artifactDrawer.isOpen}
		<!-- Resize handle on the LEFT edge -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<div
			class="artifact-resize-handle absolute left-0 top-0 z-10 h-full"
			class:is-resizing={resizing}
			role="separator"
			aria-orientation="vertical"
			aria-label="Resize artifact panel"
			tabindex="0"
			onpointerdown={onResizeStart}
			onpointermove={onResizeMove}
			onpointerup={onResizeEnd}
			onpointercancel={onResizeEnd}
			onkeydown={onResizeKey}
		></div>

		<div class="flex min-w-0 flex-1 flex-col">
			<header class="flex items-center justify-between border-b border-base-300/60 px-3 py-2">
				<div class="min-w-0 flex-1">
					<p class="text-xs uppercase tracking-wide text-base-content/50">{headerTitle}</p>
				</div>
				<button
					class="btn btn-ghost btn-xs btn-circle"
					onclick={closeDrawer}
					aria-label="Close artifact panel"
					title="Close"
				>
					✕
				</button>
			</header>
			<div class="min-w-0 flex-1 overflow-hidden">
				{#if artifactDrawer.target?.kind === 'research'}
					<ResearchArtifactView id={artifactDrawer.target.id} />
				{:else if artifactDrawer.target?.kind === 'document'}
					<DocumentArtifactView artifactId={artifactDrawer.target.artifactId} />
				{:else if artifactDrawer.target?.kind === 'image'}
					<ImageArtifactView id={artifactDrawer.target.id} />
				{/if}
			</div>
		</div>
	{/if}
</aside>

<!-- Mobile/tablet: full-screen bottom sheet at 95vh -->
{#if artifactDrawer.isOpen}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="bottom-sheet-scrim fixed inset-0 z-40 desktop:hidden"
		onclick={closeDrawer}
		onkeydown={handleKeydown}
	></div>
{/if}
<!-- svelte-ignore a11y_no_static_element_interactions -->
<aside
	class="bottom-sheet bg-base-100 border-base-300 fixed inset-x-0 bottom-0 z-50 flex max-h-[95vh] flex-col rounded-t-2xl border-t desktop:hidden"
	style="transform: {mobilePanelTransform}; transition: {mobilePanelTransition};"
	ontouchstart={onTouchStart}
	ontouchmove={onTouchMove}
	ontouchend={onTouchEnd}
>
	<div class="flex shrink-0 items-center justify-center pb-1 pt-3">
		<div class="bg-base-content/20 h-1 w-10 rounded-full"></div>
	</div>
	<div class="flex shrink-0 items-center justify-between border-b border-base-300/60 px-3 pb-2 pt-1">
		<p class="text-xs uppercase tracking-wide text-base-content/50">{headerTitle}</p>
		<button
			class="btn btn-ghost btn-xs btn-circle"
			onclick={closeDrawer}
			aria-label="Close artifact panel"
			title="Close"
		>
			✕
		</button>
	</div>
	<div bind:this={scrollEl} class="flex-1 overflow-y-auto overscroll-none">
		{#if artifactDrawer.target?.kind === 'research'}
			<ResearchArtifactView id={artifactDrawer.target.id} />
		{:else if artifactDrawer.target?.kind === 'document'}
			<DocumentArtifactView artifactId={artifactDrawer.target.artifactId} />
		{:else if artifactDrawer.target?.kind === 'image'}
			<ImageArtifactView id={artifactDrawer.target.id} />
		{/if}
	</div>
</aside>

<style>
	.artifact-resize-handle {
		width: 6px;
		cursor: col-resize;
		touch-action: none;
		background: transparent;
		transition: background-color 120ms ease-out;
	}
	.artifact-resize-handle:hover,
	.artifact-resize-handle:focus-visible,
	.artifact-resize-handle.is-resizing {
		background: var(--color-primary);
		opacity: 0.45;
	}
</style>
