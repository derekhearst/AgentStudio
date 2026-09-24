import { expect, test } from '@playwright/test'
import {
	groupConversations,
	listTime,
	sortConversations,
	type OrderableConversation,
} from '../src/lib/chat/conversation-order'

/**
 * #18 — the order the sidebar shows conversations in.
 *
 * Pure: `conversation-order.ts` imports nothing but the day helpers, so this runs without a
 * database or a server. The server sends pinned chats first by pin time and the archive by
 * archive time; the sidebar used to re-sort everything by last activity and throw that away.
 * What is pinned:
 *   - the Pinned group is ordered by when each chat was pinned, not by its last activity
 *   - the rest of the list is ordered by last activity, and a pinned chat is not repeated there
 *   - the archive is ordered, grouped by day and dated by when each chat was archived
 *   - "Sort by Name" is an explicit choice and applies inside the Pinned group too
 *   - groups are keyed by the day, so the same date a year apart makes two groups
 */

/** Local noon on a day, so the day a timestamp falls on never depends on the time zone. */
function day(year: number, month: number, date: number, hour = 12): Date {
	return new Date(year, month - 1, date, hour)
}

function chat(id: string, fields: Partial<OrderableConversation> = {}): OrderableConversation {
	return {
		id,
		title: id,
		category: null,
		updatedAt: day(2026, 9, 1),
		pinnedAt: null,
		archivedAt: null,
		...fields,
	}
}

const ids = (list: Array<{ id: string }>) => list.map((c) => c.id)

test.describe('conversation order', () => {
	test('pinned chats come first, newest pin first, whatever their last activity', () => {
		const list = [
			// Pinned long ago, but busy today.
			chat('pinned-first', { pinnedAt: day(2026, 1, 1), updatedAt: day(2026, 9, 20) }),
			// Pinned yesterday, quiet for months.
			chat('pinned-last', { pinnedAt: day(2026, 9, 19), updatedAt: day(2025, 3, 1) }),
			chat('recent', { updatedAt: day(2026, 9, 18) }),
			chat('older', { updatedAt: day(2026, 9, 10) }),
		]

		const groups = groupConversations(list, { sortBy: 'Recency', groupBy: 'None', view: 'chats' })
		expect(groups.map((g) => g.key)).toEqual(['pinned', 'group:flat'])
		expect(groups[0]).toMatchObject({ label: 'Pinned' })
		expect(ids(groups[0].items)).toEqual(['pinned-last', 'pinned-first'])
		// The rest by last activity, with no pinned chat repeated below.
		expect(groups[1]).toMatchObject({ label: 'Recent' })
		expect(ids(groups[1].items)).toEqual(['recent', 'older'])
	})

	test('with nothing pinned there is no Pinned group, and an ungrouped list needs no heading', () => {
		const groups = groupConversations([chat('a', { updatedAt: day(2026, 9, 2) }), chat('b')], {
			sortBy: 'Recency',
			groupBy: 'None',
			view: 'chats',
		})
		expect(groups).toHaveLength(1)
		expect(groups[0]).toMatchObject({ key: 'group:flat', label: '' })
		expect(ids(groups[0].items)).toEqual(['a', 'b'])
	})

	test('grouped by date, the days below the Pinned group are the days of last activity', () => {
		const list = [
			chat('pinned', { pinnedAt: day(2026, 9, 21), updatedAt: day(2026, 9, 1) }),
			chat('mon-late', { updatedAt: day(2026, 9, 14, 18) }),
			chat('mon-early', { updatedAt: day(2026, 9, 14, 9) }),
			chat('sun', { updatedAt: day(2026, 9, 13) }),
		]
		const groups = groupConversations(list, { sortBy: 'Recency', groupBy: 'Date', view: 'chats' })
		expect(groups.map((g) => g.key)).toEqual(['pinned', 'day:2026-09-14', 'day:2026-09-13'])
		expect(ids(groups[1].items)).toEqual(['mon-late', 'mon-early'])
		// The pinned chat's own day (Sept 1) has no group: it is listed once, on top.
		expect(groups.flatMap((g) => ids(g.items))).toEqual(['pinned', 'mon-late', 'mon-early', 'sun'])
	})

	test('the same date a year apart is two groups, not one', () => {
		const groups = groupConversations(
			[chat('this-year', { updatedAt: day(2026, 3, 14) }), chat('last-year', { updatedAt: day(2025, 3, 14) })],
			{ sortBy: 'Recency', groupBy: 'Date', view: 'chats' },
		)
		expect(groups.map((g) => g.key)).toEqual(['day:2026-03-14', 'day:2025-03-14'])
		expect(new Set(groups.map((g) => g.key)).size).toBe(groups.length)
	})

	test('the archive is ordered, grouped and dated by when each chat was archived', () => {
		const list = [
			// Last active long ago, archived today: it belongs at the top of the archive.
			chat('archived-today', { updatedAt: day(2026, 6, 1), archivedAt: day(2026, 9, 22) }),
			// Busy recently, archived last week.
			chat('archived-earlier', { updatedAt: day(2026, 9, 21), archivedAt: day(2026, 9, 15) }),
			chat('archived-same-day', { updatedAt: day(2026, 9, 20), archivedAt: day(2026, 9, 22, 8) }),
		]

		const flat = groupConversations(list, { sortBy: 'Recency', groupBy: 'None', view: 'archive' })
		expect(flat).toHaveLength(1)
		expect(ids(flat[0].items)).toEqual(['archived-today', 'archived-same-day', 'archived-earlier'])

		const byDay = groupConversations(list, { sortBy: 'Recency', groupBy: 'Date', view: 'archive' })
		expect(byDay.map((g) => g.key)).toEqual(['day:2026-09-22', 'day:2026-09-15'])
		expect(ids(byDay[0].items)).toEqual(['archived-today', 'archived-same-day'])

		// The row's time is the archive time there, and the last activity everywhere else.
		expect(listTime(list[0], 'archive')).toEqual(day(2026, 9, 22))
		expect(listTime(list[0], 'chats')).toEqual(day(2026, 6, 1))
	})

	test('the archive has no Pinned group', () => {
		// Archiving unpins on the server; a stale row that says both is still shown as archived.
		const groups = groupConversations([chat('both', { pinnedAt: day(2026, 9, 1), archivedAt: day(2026, 9, 2) })], {
			sortBy: 'Recency',
			groupBy: 'None',
			view: 'archive',
		})
		expect(groups.map((g) => g.key)).toEqual(['group:flat'])
	})

	test('sorting by name applies inside the Pinned group as well', () => {
		const list = [
			chat('b-pinned', { title: 'Bravo', pinnedAt: day(2026, 9, 22) }),
			chat('a-pinned', { title: 'Alpha', pinnedAt: day(2026, 9, 1) }),
			chat('c', { title: 'Charlie' }),
			chat('d', { title: 'Delta', updatedAt: day(2026, 9, 22) }),
		]
		const groups = groupConversations(list, { sortBy: 'Name', groupBy: 'None', view: 'chats' })
		expect(ids(groups[0].items)).toEqual(['a-pinned', 'b-pinned'])
		expect(ids(groups[1].items)).toEqual(['c', 'd'])
	})

	test('grouping by project puts chats with no category under Uncategorized', () => {
		const groups = groupConversations(
			[chat('x', { category: 'Infra' }), chat('y'), chat('z', { category: 'Infra', updatedAt: day(2026, 9, 5) })],
			{ sortBy: 'Recency', groupBy: 'Project', view: 'chats' },
		)
		expect(groups.map((g) => g.key)).toEqual(['category:Infra', 'category:Uncategorized'])
		expect(ids(groups[0].items)).toEqual(['z', 'x'])
	})

	test('the "Recent chats" order ignores pins, and nothing sorts the list it was given', () => {
		const list = [
			chat('pinned-old', { pinnedAt: day(2026, 9, 22), updatedAt: day(2020, 1, 1) }),
			chat('newest', { updatedAt: day(2026, 9, 22) }),
			chat('middle', { updatedAt: day(2026, 9, 10) }),
		]
		const before = ids(list)
		expect(ids(sortConversations(list, 'Recency', 'chats'))).toEqual(['newest', 'middle', 'pinned-old'])
		groupConversations(list, { sortBy: 'Recency', groupBy: 'Date', view: 'chats' })
		expect(ids(list)).toEqual(before)
	})
})
