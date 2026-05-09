/**
 * Pure step functions for the typewriter interpolation that animates incoming
 * text + reasoning content towards their accumulated targets.
 *
 * The chat page owns the requestAnimationFrame loop + the $state variables; this
 * module only handles the math: given the current blocks and the target string
 * the SSE stream is filling, return the next blocks (or null if no change) and
 * whether the animation has caught up.
 *
 * Speeds tuned for the human eye: thinking blocks render at 70-220 char/s
 * (slightly slower because reasoning is denser), text drafts at 80-280 char/s.
 * Both scale with `remaining` so a long final flush doesn't crawl.
 */

import type { StreamingBlock } from './streaming-blocks'

export type InterpolationFrame = {
	/** Next blocks array, or `null` if this frame produced no change. */
	blocks: StreamingBlock[] | null
	/** Whether the rendered content has caught up to the target — caller stops the rAF loop. */
	done: boolean
}

/** Step the last text block towards `target`. */
export function stepDraftFrame(
	blocks: StreamingBlock[],
	target: string,
	elapsedMs: number,
): InterpolationFrame {
	let lastIdx = -1
	for (let i = blocks.length - 1; i >= 0; i--) {
		if (blocks[i].kind === 'text') {
			lastIdx = i
			break
		}
	}
	if (lastIdx === -1) return { blocks: null, done: true }
	const block = blocks[lastIdx]
	if (block.kind !== 'text') return { blocks: null, done: true }

	const remaining = target.length - block.content.length
	if (remaining <= 0) return { blocks: null, done: true }

	const charsPerSecond = Math.min(280, Math.max(80, remaining * 4))
	const step = Math.max(1, Math.floor((charsPerSecond * Math.max(16, elapsedMs)) / 1000))
	const newContent = target.slice(0, block.content.length + step)

	return {
		blocks: blocks.map((b, i) =>
			i === lastIdx && b.kind === 'text' ? { ...b, content: newContent } : b,
		),
		done: newContent.length >= target.length,
	}
}

/** Step the last thinking block towards `target`. */
export function stepThinkingFrame(
	blocks: StreamingBlock[],
	target: string,
	elapsedMs: number,
): InterpolationFrame {
	let lastIdx = -1
	for (let i = blocks.length - 1; i >= 0; i--) {
		if (blocks[i].kind === 'thinking') {
			lastIdx = i
			break
		}
	}
	if (lastIdx === -1) return { blocks: null, done: true }
	const block = blocks[lastIdx]
	if (block.kind !== 'thinking') return { blocks: null, done: true }

	const remaining = target.length - block.content.length
	if (remaining <= 0) return { blocks: null, done: true }

	const charsPerSecond = Math.min(220, Math.max(70, remaining * 3))
	const step = Math.max(1, Math.floor((charsPerSecond * Math.max(16, elapsedMs)) / 1000))
	const newContent = target.slice(0, block.content.length + step)

	return {
		blocks: blocks.map((b, i) =>
			i === lastIdx && b.kind === 'thinking' ? { ...b, content: newContent } : b,
		),
		done: newContent.length >= target.length,
	}
}

/**
 * Returns true when the last `kind`-block exists AND its rendered content is
 * shorter than `target` — i.e. there's still typewriter work to do, so the
 * caller should queue another rAF frame.
 */
export function hasUnfinishedInterpolation(
	blocks: StreamingBlock[],
	kind: 'text' | 'thinking',
	target: string,
): boolean {
	for (let i = blocks.length - 1; i >= 0; i--) {
		const b = blocks[i]
		if (b.kind !== kind) continue
		const content = b.kind === 'text' || b.kind === 'thinking' ? b.content : ''
		return content.length < target.length
	}
	return false
}
