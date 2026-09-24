/**
 * The sidebar's order (#18): how a list of conversations is sorted and grouped for display.
 *
 * Kept out of the sidebar component so the rules can be pinned without a browser. Three of
 * them are easy to lose in a re-sort:
 *
 *   - **Pinned chats sit on top, in their own group, newest pin first.** Pinning is a
 *     deliberate "keep this handy", so the order is when it was pinned, not when the chat
 *     last had activity.
 *   - **The archive is ordered by when each chat was archived**, newest first, and grouped
 *     by that day. A chat archived today that last had activity a month ago belongs under
 *     "Today" in the archive: that is when it was put away, and what someone looking for it
 *     remembers.
 *   - **The normal list is ordered by last activity** (`updatedAt`). Pinning and archiving
 *     never move it (see `$lib/chat/conversation-lifecycle.server`).
 *
 * "Sort by Name" or "Project" is an explicit choice and applies inside every group, the
 * pinned one included.
 *
 * Imports nothing that needs SvelteKit, so specs can load it in the plain Playwright loader.
 */

import { dayKey, dayLabel } from '../util/relative-time'

export type ConversationSort = 'Recency' | 'Name' | 'Project'
export type ConversationGrouping = 'Project' | 'Status' | 'Environment' | 'Date' | 'None'
/** The normal list (pinned and recent chats) or the archive. */
export type ConversationListView = 'chats' | 'archive'

export type OrderableConversation = {
	id: string
	title: string
	category: string | null
	updatedAt: Date | string
	pinnedAt: Date | string | null
	archivedAt: Date | string | null
}

export type ConversationGroup<T> = { key: string; label: string; items: T[] }

const UNCATEGORIZED = 'Uncategorized'

function epoch(value: Date | string | null | undefined): number {
	if (!value) return 0
	const time = new Date(value).getTime()
	return Number.isNaN(time) ? 0 : time
}

/**
 * The time a row is ordered, grouped and labelled by: when it was archived in the archive,
 * its last activity everywhere else.
 */
export function listTime(conversation: OrderableConversation, view: ConversationListView): Date | string {
	return view === 'archive' ? (conversation.archivedAt ?? conversation.updatedAt) : conversation.updatedAt
}

/** Newest first by `time`; a stable sort, so ties keep the order the server sent. */
function newestFirst<T>(list: T[], time: (item: T) => number): T[] {
	return list.sort((a, b) => time(b) - time(a))
}

/** Sort a copy of `list`. `Recency` means `listTime`, newest first. */
export function sortConversations<T extends OrderableConversation>(
	list: readonly T[],
	sortBy: ConversationSort,
	view: ConversationListView,
): T[] {
	const copy = [...list]
	if (sortBy === 'Name') return copy.sort((a, b) => a.title.localeCompare(b.title))
	if (sortBy === 'Project') {
		return copy.sort((a, b) => (a.category ?? UNCATEGORIZED).localeCompare(b.category ?? UNCATEGORIZED))
	}
	return newestFirst(copy, (c) => epoch(listTime(c, view)))
}

/**
 * Sort `list` and split it into the groups the sidebar shows, top to bottom. Empty groups are
 * left out.
 *
 * Group keys are stable and unique — the day (`day:2026-09-23`) or the category rather than
 * the label, because day labels drop the year and the same date a year apart would otherwise
 * collide.
 */
export function groupConversations<T extends OrderableConversation>(
	list: readonly T[],
	options: { sortBy: ConversationSort; groupBy: ConversationGrouping; view: ConversationListView },
): ConversationGroup<T>[] {
	const { sortBy, groupBy, view } = options
	const sorted = sortConversations(list, sortBy, view)

	// The archive has no pinned group: archiving unpins.
	const pinned = view === 'archive' ? [] : sorted.filter((c) => c.pinnedAt)
	if (sortBy === 'Recency') newestFirst(pinned, (c) => epoch(c.pinnedAt))
	const rest = pinned.length > 0 ? sorted.filter((c) => !c.pinnedAt) : sorted

	const groups = bucket(rest, groupBy, view, pinned.length > 0).filter((group) => group.items.length > 0)
	return pinned.length > 0 ? [{ key: 'pinned', label: 'Pinned', items: pinned }, ...groups] : groups
}

function bucket<T extends OrderableConversation>(
	list: T[],
	groupBy: ConversationGrouping,
	view: ConversationListView,
	belowPinned: boolean,
): ConversationGroup<T>[] {
	// Ungrouped, the list needs a heading only to set it apart from the pinned group.
	if (groupBy === 'None') return [{ key: 'group:flat', label: belowPinned ? 'Recent' : '', items: list }]

	if (groupBy === 'Date') {
		const days = new Map<string, { label: string; start: number; items: T[] }>()
		for (const c of list) {
			const at = listTime(c, view)
			const key = dayKey(at)
			const existing = days.get(key)
			if (existing) {
				existing.items.push(c)
				continue
			}
			const start = new Date(at)
			start.setHours(0, 0, 0, 0)
			days.set(key, { label: dayLabel(at), start: start.getTime(), items: [c] })
		}
		return [...days.entries()]
			.sort(([, a], [, b]) => b.start - a.start)
			.map(([key, day]) => ({ key: `day:${key}`, label: day.label, items: day.items }))
	}

	// Project, Status and Environment all group by the category today.
	const categories = new Map<string, T[]>()
	for (const c of list) {
		const key = c.category ?? UNCATEGORIZED
		const items = categories.get(key)
		if (items) items.push(c)
		else categories.set(key, [c])
	}
	return [...categories.entries()].map(([key, items]) => ({ key: `category:${key}`, label: key, items }))
}
