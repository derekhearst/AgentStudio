/**
 * When the model tag is worth showing above an assistant reply.
 *
 * Pure — no database, no server. The behaviour is small enough to look obvious and subtle
 * enough to get wrong: the comparison is against the nearest earlier *assistant* message
 * that carried a model, not against the previous message, because user turns sit between
 * them and an assistant message can arrive without one.
 */

import { expect, test } from '@playwright/test'
import { shouldShowModelTag } from '../src/lib/chat/message-bubble-helpers'

const user = (id: string) => ({ id, role: 'user' as const })
const bot = (id: string, model: string | null) => ({ id, role: 'assistant' as const, model })

test('the first model-bearing reply states the model once', () => {
	const messages = [user('u1'), bot('a1', 'claude-opus-5')]
	expect(shouldShowModelTag(messages, 1)).toBe(true)
})

test('a repeated model is not restated', () => {
	const messages = [user('u1'), bot('a1', 'claude-opus-5'), user('u2'), bot('a2', 'claude-opus-5')]
	expect(shouldShowModelTag(messages, 1)).toBe(true)
	expect(shouldShowModelTag(messages, 3)).toBe(false)
})

test('a switch is announced, and the model after it is not restated', () => {
	const messages = [
		user('u1'),
		bot('a1', 'claude-opus-5'),
		user('u2'),
		bot('a2', 'claude-sonnet-5'),
		user('u3'),
		bot('a3', 'claude-sonnet-5'),
	]
	expect(shouldShowModelTag(messages, 1)).toBe(true)
	expect(shouldShowModelTag(messages, 3), 'the switch itself').toBe(true)
	expect(shouldShowModelTag(messages, 5), 'settled on the new model').toBe(false)
})

test('switching back is also a switch', () => {
	const messages = [
		bot('a1', 'claude-opus-5'),
		bot('a2', 'claude-sonnet-5'),
		bot('a3', 'claude-opus-5'),
	]
	expect(shouldShowModelTag(messages, 2)).toBe(true)
})

test('an assistant message with no model never shows a tag, and is skipped when comparing', () => {
	const messages = [bot('a1', 'claude-opus-5'), bot('a2', null), bot('a3', 'claude-opus-5')]
	expect(shouldShowModelTag(messages, 1), 'nothing to show').toBe(false)
	// a3 must compare against a1, not against the model-less a2 — otherwise a missing model
	// would make the next identical reply look like a switch.
	expect(shouldShowModelTag(messages, 2)).toBe(false)
})

test('user messages never carry the tag', () => {
	const messages = [user('u1'), bot('a1', 'claude-opus-5')]
	expect(shouldShowModelTag(messages, 0)).toBe(false)
})

test('an out-of-range index is not an error', () => {
	expect(shouldShowModelTag([], 0)).toBe(false)
	expect(shouldShowModelTag([user('u1')], 5)).toBe(false)
})
