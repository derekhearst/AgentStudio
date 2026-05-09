<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		open,
		side,
		onClose,
		ariaLabel,
		children,
	}: {
		open: boolean;
		side: 'left' | 'right';
		onClose: () => void;
		ariaLabel: string;
		children: Snippet;
	} = $props();

	let dragX = $state(0);
	let dragging = $state(false);
	let startX = 0;
	let startY = 0;
	let directionLocked = false;

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && open) onClose();
	}

	function onTouchStart(e: TouchEvent) {
		startX = e.touches[0].clientX;
		startY = e.touches[0].clientY;
		dragging = false;
		directionLocked = false;
		dragX = 0;
	}

	function onTouchMove(e: TouchEvent) {
		const dx = e.touches[0].clientX - startX;
		const dy = e.touches[0].clientY - startY;

		if (!directionLocked) {
			if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
				directionLocked = true;
				const isHorizontal = Math.abs(dx) > Math.abs(dy);
				const isClosing = side === 'left' ? dx < 0 : dx > 0;
				if (isHorizontal && isClosing) dragging = true;
			}
		}

		if (dragging) {
			dragX = dx;
			e.preventDefault();
		}
	}

	function onTouchEnd() {
		if (dragging && Math.abs(dragX) > 80) onClose();
		dragX = 0;
		dragging = false;
		directionLocked = false;
	}

	const panelStyle = $derived.by(() => {
		if (dragging) return `transform: translate3d(${dragX}px, 0, 0);`;
		return '';
	});

	$effect(() => {
		if (!open) return;
		const prev = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		return () => {
			document.body.style.overflow = prev;
		};
	});
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="console-drawer-backdrop {open ? 'is-open' : ''}"
	onclick={onClose}
	aria-hidden="true"
></div>

<div
	class="console-drawer is-{side} {open ? 'is-open' : ''} {dragging ? 'is-dragging' : ''}"
	role="dialog"
	aria-modal="true"
	aria-label={ariaLabel}
	aria-hidden={!open}
	style={panelStyle}
	ontouchstart={onTouchStart}
	ontouchmove={onTouchMove}
	ontouchend={onTouchEnd}
	ontouchcancel={onTouchEnd}
>
	<button
		type="button"
		class="console-drawer__close"
		onclick={onClose}
		aria-label="Close {ariaLabel}"
		title="Close"
		tabindex={open ? 0 : -1}
	>
		<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<path d="M18 6 6 18M6 6l12 12" />
		</svg>
	</button>
	<div class="console-drawer__body">
		{@render children()}
	</div>
</div>
