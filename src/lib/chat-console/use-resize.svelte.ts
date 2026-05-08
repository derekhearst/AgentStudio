// Resize hook factory — persists size to localStorage and exposes a draggable handler.
// Designed for the Console shell's column / panel resize handles.

import { browser } from '$app/environment';

export type ResizableSize = {
	value: number;
	startDrag: (event: MouseEvent | PointerEvent, axis: 'x' | 'y', sign?: 1 | -1) => void;
};

export function useResizableSize(
	key: string,
	initial: number,
	min: number,
	max: number,
): ResizableSize {
	let stored = initial;
	if (browser) {
		try {
			const raw = localStorage.getItem(key);
			const parsed = raw ? Number.parseInt(raw, 10) : NaN;
			if (Number.isFinite(parsed)) stored = Math.max(min, Math.min(max, parsed));
		} catch {
			/* ignore */
		}
	}

	const state = $state({ value: stored });

	function persist(value: number) {
		if (!browser) return;
		try {
			localStorage.setItem(key, String(value));
		} catch {
			/* ignore */
		}
	}

	function startDrag(event: MouseEvent | PointerEvent, axis: 'x' | 'y', sign: 1 | -1 = 1) {
		event.preventDefault();
		const startX = event.clientX;
		const startY = event.clientY;
		const startValue = state.value;
		const cursorClass = axis === 'x' ? 'console-resizing-col' : 'console-resizing-row';
		document.body.classList.add('console-resizing', cursorClass);

		const onMove = (ev: MouseEvent) => {
			const delta = axis === 'x' ? ev.clientX - startX : ev.clientY - startY;
			const next = Math.max(min, Math.min(max, startValue + sign * delta));
			state.value = next;
		};
		const onUp = () => {
			document.body.classList.remove('console-resizing', cursorClass);
			window.removeEventListener('mousemove', onMove);
			window.removeEventListener('mouseup', onUp);
			persist(state.value);
		};
		window.addEventListener('mousemove', onMove);
		window.addEventListener('mouseup', onUp);
	}

	return {
		get value() {
			return state.value;
		},
		startDrag,
	};
}
