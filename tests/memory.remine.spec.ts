import { expect, test } from '@playwright/test'
import { getActiveUserId, getSql, uniquePrefix } from './helpers'

/**
 * Re-mining a conversation after every exchange, without undoing what the user removed.
 *
 * `mine:<conversationId>` was single-use for the life of the database (jobs dedupe covered
 * finished jobs), so each conversation was mined once — only the turns that existed when its
 * first job ran were ever memorized. With that fixed, the miner runs again after every
 * exchange, and it decides what is already done from the drawers that still exist: a drawer
 * the user deleted, or a conversation they forgot, would come straight back on the next turn.
 * Tombstones close that gap, and also stop a turn an exclusion rule dropped from being
 * re-counted against the rule every time.
 *
 * Every scenario here leaves the miner with nothing to mine, so no model or embedding call
 * is made — if a tombstone were ignored, the call would be attempted and the spec would fail.
 */

type Fixture = { conversationId: string; userId: string }

async function makeConversation(prefix: string): Promise<Fixture> {
	const sql = getSql()
	const userId = await getActiveUserId()
	const [conversation] = await sql<{ id: string }[]>`
		insert into conversations (title, user_id, model, total_tokens, total_cost)
		values (${`${prefix} c`}, ${userId}, 'anthropic/claude-sonnet-4', 0, '0')
		returning id
	`
	return { conversationId: conversation.id, userId }
}

async function addMessage(fixture: Fixture, sequence: number, content: string, role = 'user') {
	const sql = getSql()
	const [message] = await sql<{ id: string }[]>`
		insert into messages (conversation_id, role, content, sequence)
		values (${fixture.conversationId}, ${role}::message_role, ${content}, ${sequence})
		returning id
	`
	return message.id
}

/** A drawer mined from `messageId`, hung off a wing → room → closet for this conversation. */
async function addDrawer(prefix: string, fixture: Fixture, messageId: string) {
	const sql = getSql()
	const [wing] = await sql<{ id: string }[]>`
		insert into memory_wings (user_id, name, slug)
		values (${fixture.userId}, ${`${prefix} w ${messageId}`}, ${`${prefix}-w-${messageId}`})
		returning id
	`
	const [room] = await sql<{ id: string }[]>`
		insert into memory_rooms (wing_id, label, conversation_id) values (${wing.id}, 'r', ${fixture.conversationId})
		returning id
	`
	const [closet] = await sql<{ id: string }[]>`
		insert into memory_closets (room_id, topic) values (${room.id}, 't') returning id
	`
	const [drawer] = await sql<{ id: string }[]>`
		insert into memory_drawers (closet_id, user_id, content, token_count, source_message_id)
		values (${closet.id}, ${fixture.userId}, 'mined', 1, ${messageId})
		returning id
	`
	return drawer.id
}

async function tombstoneReasons(messageIds: string[]) {
	const sql = getSql()
	const rows = await sql<{ message_id: string; reason: string }[]>`
		select message_id, reason from memory_message_tombstones where message_id in ${sql(messageIds)}
	`
	return Object.fromEntries(rows.map((row) => [row.message_id, row.reason]))
}

async function cleanup(prefix: string) {
	const sql = getSql()
	await sql`delete from memory_exclusion_rules where name like ${`${prefix}%`}`
	await sql`delete from memory_wings where name like ${`${prefix}%`}`
	// Messages cascade from the conversation, and tombstones from the messages.
	await sql`delete from conversations where title like ${`${prefix}%`}`
}

test.describe('memory/re-mine — what the user removed stays removed', () => {
	test('a deleted drawer is not mined back from its message', async () => {
		const prefix = uniquePrefix('remine-delete')
		try {
			const fixture = await makeConversation(prefix)
			const messageId = await addMessage(fixture, 1, `${prefix} I prefer tabs over spaces`)
			const drawerId = await addDrawer(prefix, fixture, messageId)

			const { deleteDrawer } = await import('../src/lib/memory/curation.server')
			expect(await deleteDrawer({ userId: fixture.userId, drawerId })).toBe(true)
			expect(await tombstoneReasons([messageId])).toEqual({ [messageId]: 'drawer_deleted' })

			const { listConversationsWithUnminedMessages, mineConversation } = await import('../src/lib/memory/memory.server')
			expect(await listConversationsWithUnminedMessages(fixture.userId)).not.toContain(fixture.conversationId)
			const result = await mineConversation({ conversationId: fixture.conversationId })
			expect(result.drawerIds, 'the next exchange must not re-mine the deleted drawer').toEqual([])
		} finally {
			await cleanup(prefix)
		}
	})

	test('a forgotten conversation is not mined back, but what is said afterwards is', async () => {
		const prefix = uniquePrefix('remine-forget')
		try {
			const fixture = await makeConversation(prefix)
			const mined = await addMessage(fixture, 1, `${prefix} first turn`)
			const notYetMined = await addMessage(fixture, 2, `${prefix} second turn`, 'assistant')
			await addDrawer(prefix, fixture, mined)

			const { forgetConversationMemories } = await import('../src/lib/memory/curation.server')
			const forgot = await forgetConversationMemories({ userId: fixture.userId, conversationId: fixture.conversationId })
			expect(forgot.drawersDeleted).toBe(1)
			expect(await tombstoneReasons([mined, notYetMined])).toEqual({
				[mined]: 'conversation_forgotten',
				[notYetMined]: 'conversation_forgotten',
			})

			const { listConversationsWithUnminedMessages, mineConversation } = await import('../src/lib/memory/memory.server')
			expect(await listConversationsWithUnminedMessages(fixture.userId)).not.toContain(fixture.conversationId)
			expect((await mineConversation({ conversationId: fixture.conversationId })).drawerIds).toEqual([])

			await addMessage(fixture, 3, `${prefix} a new turn after forgetting`)
			expect(await listConversationsWithUnminedMessages(fixture.userId)).toContain(fixture.conversationId)
		} finally {
			await cleanup(prefix)
		}
	})

	test('a turn an exclusion rule dropped is not re-checked, or re-counted, on the next mine', async () => {
		const prefix = uniquePrefix('remine-excluded')
		const sql = getSql()
		try {
			const fixture = await makeConversation(prefix)
			const token = `zq${Date.now().toString(36)}zq`
			const [rule] = await sql<{ id: string }[]>`
				insert into memory_exclusion_rules (user_id, name, kind, pattern)
				values (${fixture.userId}, ${`${prefix} rule`}, 'substring'::memory_exclusion_kind, ${token})
				returning id
			`
			// Worded to miss the built-in credential rules, so the spec's own rule is the one
			// that fires and its hit counter is the one to watch.
			const messageId = await addMessage(fixture, 1, `${prefix} the magic word: ${token}`)

			const { mineConversation } = await import('../src/lib/memory/memory.server')
			const first = await mineConversation({ conversationId: fixture.conversationId })
			expect(first.excludedTurns).toBe(1)
			expect(await tombstoneReasons([messageId])).toEqual({ [messageId]: 'excluded_by_rule' })

			// The next exchange's mining run.
			const second = await mineConversation({ conversationId: fixture.conversationId })
			expect(second.excludedTurns).toBe(0)
			const [{ hit_count }] = await sql<{ hit_count: number }[]>`
				select hit_count from memory_exclusion_rules where id = ${rule.id}
			`
			expect(hit_count, 'one turn blocked once, not once per exchange').toBe(1)
		} finally {
			await cleanup(prefix)
		}
	})
})

test.describe('memory/re-mine — what "Mine pending" sweeps', () => {
	test('conversations with a message the miner would still pick up, and only those', async () => {
		const prefix = uniquePrefix('remine-pending')
		try {
			const fullyMined = await makeConversation(prefix)
			await addDrawer(prefix, fullyMined, await addMessage(fullyMined, 1, `${prefix} mined`))

			const partlyMined = await makeConversation(prefix)
			await addDrawer(prefix, partlyMined, await addMessage(partlyMined, 1, `${prefix} mined`))
			await addMessage(partlyMined, 2, `${prefix} arrived after the last mine`, 'assistant')

			const nothingToMine = await makeConversation(prefix)
			await addMessage(nothingToMine, 1, '   ')
			await addMessage(nothingToMine, 2, `${prefix} tool output`, 'tool')

			const { listConversationsWithUnminedMessages } = await import('../src/lib/memory/memory.server')
			const pending = await listConversationsWithUnminedMessages(fullyMined.userId)
			expect(pending).toContain(partlyMined.conversationId)
			expect(pending).not.toContain(fullyMined.conversationId)
			expect(pending).not.toContain(nothingToMine.conversationId)
		} finally {
			await cleanup(prefix)
		}
	})
})

test.describe('memory/re-mine — tombstoning a long conversation', () => {
	test('more messages than one statement can carry are all tombstoned', async () => {
		// One insert of every id passed three bind parameters per message, and Postgres takes
		// at most 65,535 per statement: forgetting a conversation of ~22k messages failed.
		test.setTimeout(60_000)
		const prefix = uniquePrefix('remine-long')
		const sql = getSql()
		try {
			const fixture = await makeConversation(prefix)
			const rows = await sql<{ id: string }[]>`
				insert into messages (conversation_id, role, content, sequence)
				select ${fixture.conversationId}::uuid, 'user'::message_role, 'turn', g from generate_series(1, 22000) g
				returning id
			`
			const { tombstoneMessages } = await import('../src/lib/memory/tombstones.server')
			await tombstoneMessages(
				fixture.userId,
				rows.map((row) => row.id),
				'conversation_forgotten',
			)
			const [{ count }] = await sql<{ count: number }[]>`
				select count(*)::int as count from memory_message_tombstones t
				join messages m on m.id = t.message_id
				where m.conversation_id = ${fixture.conversationId}
			`
			expect(count).toBe(22000)
		} finally {
			await cleanup(prefix)
		}
	})
})
