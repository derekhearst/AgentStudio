<script lang="ts">
	import { onMount } from 'svelte';
	import {
		kindColor,
		layoutWings,
		RING_RADII_PUBLIC,
		wingInitials,
		type LayoutNode,
	} from '$lib/memory/memory-map.layout';
	import type { MemoryWingRow, MemoryWingEdge } from '$lib/memory/memory.remote';
	import { relativeTime } from '$lib/util/relative-time';

	let {
		wings,
		edges = [],
		selectedWingId = null,
		highlightedWingIds = [],
		userLabel = 'You',
		onSelect,
	}: {
		wings: MemoryWingRow[];
		edges?: MemoryWingEdge[];
		selectedWingId?: string | null;
		highlightedWingIds?: string[];
		userLabel?: string;
		onSelect?: (id: string) => void;
	} = $props();

	const layout = $derived(layoutWings(wings, edges));
	const highlightSet = $derived(new Set(highlightedWingIds));

	let containerEl: HTMLDivElement | undefined = $state(undefined);
	let viewportW = $state(800);
	let viewportH = $state(600);

	let zoom = $state(1);
	let panX = $state(0);
	let panY = $state(0);

	let dragging = $state(false);
	let dragStartX = 0;
	let dragStartY = 0;
	let panStartX = 0;
	let panStartY = 0;

	let hoverNode = $state<LayoutNode | null>(null);
	let hoverX = $state(0);
	let hoverY = $state(0);

	const viewBox = $derived.by(() => {
		const baseW = layout.width;
		const baseH = layout.height;
		const w = baseW / zoom;
		const h = baseH / zoom;
		const cx = layout.centerX - w / 2 - panX / zoom;
		const cy = layout.centerY - h / 2 - panY / zoom;
		return `${cx} ${cy} ${w} ${h}`;
	});

	function onPointerDown(e: PointerEvent) {
		if (e.button !== 0) return;
		dragging = true;
		dragStartX = e.clientX;
		dragStartY = e.clientY;
		panStartX = panX;
		panStartY = panY;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}

	function onPointerMove(e: PointerEvent) {
		if (!dragging) return;
		panX = panStartX + (e.clientX - dragStartX);
		panY = panStartY + (e.clientY - dragStartY);
	}

	function onPointerUp(e: PointerEvent) {
		dragging = false;
		try {
			(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
		} catch {
			/* ignore */
		}
	}

	function onWheel(e: WheelEvent) {
		e.preventDefault();
		const factor = e.deltaY > 0 ? 0.9 : 1.1;
		const next = Math.max(0.4, Math.min(3, zoom * factor));
		zoom = next;
	}

	function recenter() {
		zoom = 1;
		panX = 0;
		panY = 0;
	}

	function showTooltip(node: LayoutNode, e: MouseEvent) {
		hoverNode = node;
		const rect = containerEl?.getBoundingClientRect();
		hoverX = rect ? e.clientX - rect.left : e.clientX;
		hoverY = rect ? e.clientY - rect.top : e.clientY;
	}

	function hideTooltip() {
		hoverNode = null;
	}

	// relativeTime imported from $lib/util/relative-time with weekFallback for older drawers.
	const tooltipRelativeTime = (d: string | Date | null) => relativeTime(d, { weekFallback: true });

	onMount(() => {
		if (!containerEl) return;
		const ro = new ResizeObserver((entries) => {
			for (const entry of entries) {
				viewportW = entry.contentRect.width;
				viewportH = entry.contentRect.height;
			}
		});
		ro.observe(containerEl);
		return () => ro.disconnect();
	});
</script>

<div class="memory-map" bind:this={containerEl}>
	<div class="memory-map__controls">
		<button class="console-iconbtn" title="Zoom in" onclick={() => (zoom = Math.min(3, zoom * 1.2))} aria-label="Zoom in">
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-4 w-4"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M11 8v6M8 11h6"/></svg>
		</button>
		<button class="console-iconbtn" title="Zoom out" onclick={() => (zoom = Math.max(0.4, zoom / 1.2))} aria-label="Zoom out">
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-4 w-4"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6"/></svg>
		</button>
		<button class="console-iconbtn" title="Recenter" onclick={recenter} aria-label="Recenter">
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-4 w-4"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>
		</button>
	</div>

	<div
		class="memory-map__legend"
		role="presentation"
		aria-label="Legend"
	>
		<span class="memory-map__legend-item is-person"><span class="dot"></span> Person</span>
		<span class="memory-map__legend-item is-project"><span class="dot"></span> Project</span>
		<span class="memory-map__legend-item is-topic"><span class="dot"></span> Topic</span>
		<span class="memory-map__legend-item is-agent"><span class="dot"></span> Agent</span>
	</div>

	<svg
		class="memory-map__svg"
		class:is-dragging={dragging}
		viewBox={viewBox}
		preserveAspectRatio="xMidYMid meet"
		onpointerdown={onPointerDown}
		onpointermove={onPointerMove}
		onpointerup={onPointerUp}
		onpointercancel={onPointerUp}
		onwheel={onWheel}
		role="application"
		aria-label="Memory palace map"
	>
		<!-- Concentric rings -->
		{#each RING_RADII_PUBLIC as r, i (r)}
			<circle
				cx={layout.centerX}
				cy={layout.centerY}
				{r}
				class="memory-map__ring"
				class:is-inner={i === 0}
			/>
		{/each}

		<!-- Edges -->
		{#each layout.edges as edge (edge.a + ':' + edge.b)}
			<line
				x1={edge.x1}
				y1={edge.y1}
				x2={edge.x2}
				y2={edge.y2}
				class="memory-map__edge"
				stroke-width={Math.min(2.5, 0.4 + edge.weight * 0.5)}
			/>
		{/each}

		<!-- User node at centre -->
		<g class="memory-map__user">
			<circle cx={layout.centerX} cy={layout.centerY} r={layout.userR + 6} class="memory-map__user-ring" />
			<circle cx={layout.centerX} cy={layout.centerY} r={layout.userR} class="memory-map__user-core" />
			<text x={layout.centerX} y={layout.centerY + 5} text-anchor="middle" class="memory-map__user-label">{userLabel}</text>
		</g>

		<!-- Wing nodes -->
		{#each layout.nodes as node (node.id)}
			{@const colors = kindColor(node.kind)}
			{@const selected = selectedWingId === node.id}
			{@const highlighted = highlightSet.has(node.id)}
			<g
				class="memory-map__node {colors.className}"
				class:is-selected={selected}
				class:is-highlighted={highlighted}
				transform={`translate(${node.x}, ${node.y})`}
				role="button"
				tabindex="0"
				aria-label={`${node.kind} ${node.name}, ${node.drawerCount} drawers`}
				onclick={() => onSelect?.(node.id)}
				onkeydown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						onSelect?.(node.id);
					}
				}}
				onmouseenter={(e) => showTooltip(node, e)}
				onmousemove={(e) => showTooltip(node, e)}
				onmouseleave={hideTooltip}
			>
				<circle r={node.r + 4} class="memory-map__node-halo" fill={colors.stroke} />
				<circle r={node.r} class="memory-map__node-core" fill={colors.fill} stroke={colors.stroke} />
				<text y="4" text-anchor="middle" class="memory-map__node-initials" fill={colors.text}>
					{wingInitials(node.name)}
				</text>
				<text y={node.r + 16} text-anchor="middle" class="memory-map__node-label">
					{node.name.length > 18 ? node.name.slice(0, 17) + '…' : node.name}
				</text>
				{#if node.drawerCount > 0}
					<text y={node.r + 28} text-anchor="middle" class="memory-map__node-count">
						{node.drawerCount} drawer{node.drawerCount === 1 ? '' : 's'}
					</text>
				{/if}
			</g>
		{/each}
	</svg>

	{#if hoverNode}
		<div
			class="memory-map__tooltip"
			style:transform={`translate(${hoverX + 14}px, ${hoverY + 14}px)`}
		>
			<div class="memory-map__tooltip-head">
				<span class="memory-map__tooltip-kind {kindColor(hoverNode.kind).className}">{hoverNode.kind}</span>
				<span class="memory-map__tooltip-name">{hoverNode.name}</span>
			</div>
			{#if hoverNode.summary}
				<div class="memory-map__tooltip-summary">{hoverNode.summary}</div>
			{/if}
			<div class="memory-map__tooltip-stats">
				<span>{hoverNode.drawerCount} drawer{hoverNode.drawerCount === 1 ? '' : 's'}</span>
				<span>·</span>
				<span>{hoverNode.roomCount} room{hoverNode.roomCount === 1 ? '' : 's'}</span>
				<span>·</span>
				<span>last {tooltipRelativeTime(hoverNode.lastTouchedAt)}</span>
			</div>
			{#if hoverNode.aliases.length}
				<div class="memory-map__tooltip-aliases">aka {hoverNode.aliases.join(', ')}</div>
			{/if}
		</div>
	{/if}

	{#if wings.length === 0}
		<div class="memory-map__empty">
			<div class="memory-map__empty-title">No memories yet</div>
			<div class="memory-map__empty-hint">Start a chat — wings get created automatically as you talk.</div>
		</div>
	{/if}
</div>

<style>
	.memory-map {
		position: relative;
		width: 100%;
		height: 100%;
		min-height: 480px;
		background:
			radial-gradient(circle at center, color-mix(in oklab, var(--color-primary) 4%, transparent), transparent 60%),
			color-mix(in oklab, var(--color-base-content) 1.5%, var(--color-base-100));
		border-radius: 12px;
		overflow: hidden;
		isolation: isolate;
	}

	.memory-map__controls {
		position: absolute;
		top: 8px;
		right: 8px;
		display: flex;
		gap: 4px;
		z-index: 3;
		background: color-mix(in oklab, var(--color-base-100) 80%, transparent);
		backdrop-filter: blur(8px);
		padding: 4px;
		border-radius: 8px;
		border: 1px solid var(--color-base-300);
	}

	.memory-map__legend {
		position: absolute;
		bottom: 8px;
		left: 8px;
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		z-index: 3;
		background: color-mix(in oklab, var(--color-base-100) 80%, transparent);
		backdrop-filter: blur(8px);
		padding: 4px 8px;
		border-radius: 999px;
		border: 1px solid var(--color-base-300);
		font-size: 10.5px;
		color: color-mix(in oklab, var(--color-base-content) 70%, transparent);
		font-family: Consolas, 'Cascadia Code', monospace;
	}

	.memory-map__legend-item {
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}

	.memory-map__legend-item .dot {
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 999px;
	}

	.memory-map__legend-item.is-person .dot { background: var(--color-primary); }
	.memory-map__legend-item.is-project .dot { background: var(--color-secondary); }
	.memory-map__legend-item.is-topic .dot { background: var(--color-accent); }
	.memory-map__legend-item.is-agent .dot { background: var(--color-info); }

	.memory-map__svg {
		width: 100%;
		height: 100%;
		display: block;
		cursor: grab;
		touch-action: none;
		user-select: none;
	}

	.memory-map__svg.is-dragging {
		cursor: grabbing;
	}

	.memory-map__ring {
		fill: none;
		stroke: color-mix(in oklab, var(--color-base-content) 8%, transparent);
		stroke-dasharray: 2 6;
	}

	.memory-map__ring.is-inner {
		stroke: color-mix(in oklab, var(--color-base-content) 12%, transparent);
	}

	.memory-map__edge {
		stroke: color-mix(in oklab, var(--color-base-content) 18%, transparent);
		opacity: 0.55;
	}

	.memory-map__user-ring {
		fill: none;
		stroke: color-mix(in oklab, var(--color-primary) 35%, transparent);
		stroke-width: 1;
		stroke-dasharray: 4 4;
	}

	.memory-map__user-core {
		fill: var(--color-primary);
		stroke: var(--color-primary-content);
		stroke-width: 1.5;
		filter: drop-shadow(0 0 12px color-mix(in oklab, var(--color-primary) 45%, transparent));
	}

	.memory-map__user-label {
		fill: var(--color-primary-content);
		font-size: 12px;
		font-weight: 600;
		font-family: Consolas, 'Cascadia Code', monospace;
		pointer-events: none;
	}

	.memory-map__node {
		cursor: pointer;
		transition: transform 120ms;
	}

	.memory-map__node:hover {
		transform-origin: center;
	}

	.memory-map__node-halo {
		opacity: 0;
		transition: opacity 120ms;
	}

	.memory-map__node:hover .memory-map__node-halo,
	.memory-map__node.is-selected .memory-map__node-halo,
	.memory-map__node.is-highlighted .memory-map__node-halo {
		opacity: 0.25;
	}

	.memory-map__node.is-selected .memory-map__node-halo {
		opacity: 0.45;
	}

	.memory-map__node-core {
		stroke-width: 1.5;
		transition: stroke-width 120ms;
	}

	.memory-map__node.is-selected .memory-map__node-core {
		stroke-width: 3;
	}

	.memory-map__node-initials {
		font-family: Consolas, 'Cascadia Code', monospace;
		font-size: 11px;
		font-weight: 700;
		pointer-events: none;
	}

	.memory-map__node-label {
		fill: var(--color-base-content);
		font-size: 11px;
		font-family: Consolas, 'Cascadia Code', monospace;
		pointer-events: none;
	}

	.memory-map__node-count {
		fill: color-mix(in oklab, var(--color-base-content) 50%, transparent);
		font-size: 9.5px;
		font-family: Consolas, 'Cascadia Code', monospace;
		pointer-events: none;
	}

	.memory-map__tooltip {
		position: absolute;
		top: 0;
		left: 0;
		max-width: 280px;
		background: var(--color-base-100);
		border: 1px solid var(--color-base-300);
		border-radius: 8px;
		padding: 8px 10px;
		font-family: Consolas, 'Cascadia Code', monospace;
		font-size: 11px;
		color: var(--color-base-content);
		box-shadow: 0 8px 24px color-mix(in oklab, var(--color-base-content) 16%, transparent);
		pointer-events: none;
		z-index: 5;
	}

	.memory-map__tooltip-head {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 4px;
	}

	.memory-map__tooltip-kind {
		font-size: 9.5px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		padding: 1px 5px;
		border-radius: 3px;
		border: 1px solid currentColor;
	}

	.memory-map__tooltip-kind.is-person { color: var(--color-primary); }
	.memory-map__tooltip-kind.is-project { color: var(--color-secondary); }
	.memory-map__tooltip-kind.is-topic { color: var(--color-accent); }
	.memory-map__tooltip-kind.is-agent { color: var(--color-info); }

	.memory-map__tooltip-name { font-weight: 600; }

	.memory-map__tooltip-summary {
		color: color-mix(in oklab, var(--color-base-content) 70%, transparent);
		margin-bottom: 4px;
	}

	.memory-map__tooltip-stats {
		display: flex;
		gap: 4px;
		font-size: 10px;
		color: color-mix(in oklab, var(--color-base-content) 55%, transparent);
	}

	.memory-map__tooltip-aliases {
		margin-top: 4px;
		font-size: 10px;
		color: color-mix(in oklab, var(--color-base-content) 50%, transparent);
		font-style: italic;
	}

	.memory-map__empty {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		text-align: center;
		gap: 4px;
		font-family: Consolas, 'Cascadia Code', monospace;
		pointer-events: none;
	}

	.memory-map__empty-title {
		font-size: 14px;
		font-weight: 600;
		color: var(--color-base-content);
	}

	.memory-map__empty-hint {
		font-size: 11.5px;
		color: color-mix(in oklab, var(--color-base-content) 55%, transparent);
	}
</style>
