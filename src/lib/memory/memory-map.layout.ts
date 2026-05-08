/**
 * Pure layout for the concentric "memory map".
 *
 * The user sits at the centre of the SVG canvas. Wings orbit around them on three
 * concentric rings, grouped by kind. Edges between wings (shared KG entities or
 * conversations) are drawn as light splines through the centre.
 */

import type { MemoryWingRow, MemoryWingEdge } from '$lib/memory/memory.remote'

export type WingKind = 'person' | 'project' | 'topic' | 'agent'

export type LayoutNode = {
	id: string
	name: string
	kind: WingKind
	drawerCount: number
	roomCount: number
	lastTouchedAt: string | Date | null
	summary: string | null
	aliases: string[]
	x: number
	y: number
	r: number // node radius in svg units
	ringIndex: 0 | 1 | 2
}

export type LayoutEdge = {
	a: string
	b: string
	weight: number
	x1: number
	y1: number
	x2: number
	y2: number
}

export type Layout = {
	width: number
	height: number
	centerX: number
	centerY: number
	userR: number
	nodes: LayoutNode[]
	edges: LayoutEdge[]
}

const KIND_RING: Record<WingKind, 0 | 1 | 2> = {
	person: 0,
	project: 1,
	topic: 2,
	agent: 2,
}

const RING_RADII = [180, 320, 460] as const

export function layoutWings(
	wings: MemoryWingRow[],
	edges: MemoryWingEdge[] = [],
	opts: { width?: number; height?: number; maxNodeR?: number; minNodeR?: number } = {},
): Layout {
	const width = opts.width ?? 1100
	const height = opts.height ?? 1100
	const centerX = width / 2
	const centerY = height / 2
	const minR = opts.minNodeR ?? 14
	const maxR = opts.maxNodeR ?? 38

	const maxDrawers = Math.max(1, ...wings.map((w) => w.drawerCount ?? 0))

	// Group wings by ring.
	const ringBuckets: MemoryWingRow[][] = [[], [], []]
	for (const wing of wings) {
		const ring = KIND_RING[wing.kind as WingKind] ?? 2
		ringBuckets[ring].push(wing)
	}

	// Within a ring, sort by drawerCount desc so heavy nodes come first; we'll
	// space them evenly around the ring.
	for (const bucket of ringBuckets) {
		bucket.sort((a, b) => (b.drawerCount ?? 0) - (a.drawerCount ?? 0))
	}

	const nodes: LayoutNode[] = []
	const indexById = new Map<string, LayoutNode>()

	ringBuckets.forEach((bucket, ringIndex) => {
		const ringR = RING_RADII[ringIndex]
		const n = bucket.length
		if (n === 0) return
		// Stagger ring starting angle by ring index so nodes don't all line up.
		const startAngle = -Math.PI / 2 + ringIndex * 0.35
		bucket.forEach((wing, i) => {
			const theta = startAngle + (i / n) * Math.PI * 2
			const x = centerX + ringR * Math.cos(theta)
			const y = centerY + ringR * Math.sin(theta)
			const drawerCount = wing.drawerCount ?? 0
			const scale = Math.sqrt(drawerCount / maxDrawers)
			const r = Math.max(minR, Math.min(maxR, minR + scale * (maxR - minR)))
			const node: LayoutNode = {
				id: wing.id,
				name: wing.name,
				kind: (wing.kind as WingKind) ?? 'topic',
				drawerCount,
				roomCount: wing.roomCount ?? 0,
				lastTouchedAt: wing.lastTouchedAt ?? null,
				summary: wing.summary ?? null,
				aliases: wing.aliases ?? [],
				x,
				y,
				r,
				ringIndex: ringIndex as 0 | 1 | 2,
			}
			nodes.push(node)
			indexById.set(wing.id, node)
		})
	})

	const layoutEdges: LayoutEdge[] = []
	for (const edge of edges) {
		const a = indexById.get(edge.a)
		const b = indexById.get(edge.b)
		if (!a || !b) continue
		layoutEdges.push({
			a: edge.a,
			b: edge.b,
			weight: edge.weight,
			x1: a.x,
			y1: a.y,
			x2: b.x,
			y2: b.y,
		})
	}

	return {
		width,
		height,
		centerX,
		centerY,
		userR: 38,
		nodes,
		edges: layoutEdges,
	}
}

export const RING_RADII_PUBLIC = RING_RADII

export function kindColor(kind: WingKind): {
	stroke: string
	fill: string
	text: string
	className: string
} {
	switch (kind) {
		case 'person':
			return {
				stroke: 'var(--color-primary)',
				fill: 'color-mix(in oklab, var(--color-primary) 18%, var(--color-base-100))',
				text: 'var(--color-primary)',
				className: 'is-person',
			}
		case 'project':
			return {
				stroke: 'var(--color-secondary)',
				fill: 'color-mix(in oklab, var(--color-secondary) 18%, var(--color-base-100))',
				text: 'var(--color-secondary)',
				className: 'is-project',
			}
		case 'agent':
			return {
				stroke: 'var(--color-info)',
				fill: 'color-mix(in oklab, var(--color-info) 18%, var(--color-base-100))',
				text: 'var(--color-info)',
				className: 'is-agent',
			}
		case 'topic':
		default:
			return {
				stroke: 'var(--color-accent)',
				fill: 'color-mix(in oklab, var(--color-accent) 18%, var(--color-base-100))',
				text: 'var(--color-accent)',
				className: 'is-topic',
			}
	}
}

export function wingInitials(name: string): string {
	return (
		name
			.split(/\s+/)
			.filter(Boolean)
			.map((w) => w[0] ?? '')
			.join('')
			.slice(0, 2)
			.toUpperCase() || '·'
	)
}
