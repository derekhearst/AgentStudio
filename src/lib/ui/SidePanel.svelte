<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		open = $bindable(false),
		children,
		class: className = '',
	}: {
		open?: boolean;
		children?: Snippet;
		class?: string;
	} = $props();

	function handleOverlayClick() {
		open = false;
	}

	function handleKeydown(event: KeyboardEvent) {
		if (open && event.key === 'Escape') open = false;
	}

	// Pull-down-to-dismiss for mobile panel
	let dragY = $state(0);
	let dragging = $state(false);
	let startY = 0;
	let scrollEl: HTMLDivElement | undefined = $state(undefined);

	function onTouchStart(e: TouchEvent) {
		// Only start tracking if the scroll container is at the top
		if (scrollEl && scrollEl.scrollTop > 0) return;
		startY = e.touches[0].clientY;
		dragging = false;
		dragY = 0;
	}

	function onTouchMove(e: TouchEvent) {
		const currentY = e.touches[0].clientY;
		const delta = currentY - startY;

		// Only activate pull-down (positive delta) when scrolled to top
		if (delta > 0 && scrollEl && scrollEl.scrollTop <= 0) {
			dragging = true;
			dragY = delta;
			// Prevent browser pull-to-refresh
			e.preventDefault();
		} else if (!dragging) {
			// Let normal scrolling happen
			return;
		}
	}

	function onTouchEnd() {
		if (dragging && dragY > 100) {
			open = false;
		}
		dragY = 0;
		dragging = false;
	}

	const mobilePanelTransform = $derived.by(() => {
		if (!open) return 'translateY(100%)';
		if (dragging && dragY > 0) return `translateY(${dragY}px)`;
		return 'translateY(0)';
	});

	const mobilePanelTransition = $derived(
		dragging ? 'none' : 'transform 200ms ease-out'
	);
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- Desktop: inline sidebar column -->
<aside class="hidden overflow-y-auto rounded-3xl border border-base-300 bg-base-100/80 p-4 shadow-sm lg:block {className}">
	{#if children}{@render children()}{/if}
</aside>

<!-- Mobile/tablet: bottom sheet overlay -->
{#if open}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm lg:hidden"
		onclick={handleOverlayClick}
		onkeydown={handleKeydown}
	></div>
{/if}
<!-- svelte-ignore a11y_no_static_element_interactions -->
<aside
	class="fixed inset-x-0 bottom-0 z-50 flex max-h-[85vh] flex-col rounded-t-2xl border-t border-base-300 bg-base-100 shadow-lg lg:hidden {className}"
	style="transform: {mobilePanelTransform}; transition: {mobilePanelTransition};"
	ontouchstart={onTouchStart}
	ontouchmove={onTouchMove}
	ontouchend={onTouchEnd}
>
	<!-- Drag handle -->
	<div class="flex shrink-0 items-center justify-center pb-1 pt-3">
		<div class="h-1 w-10 rounded-full bg-base-content/20"></div>
	</div>
	<div bind:this={scrollEl} class="flex-1 overflow-y-auto overscroll-none px-4 pb-4">
		{#if children}{@render children()}{/if}
	</div>
</aside>
