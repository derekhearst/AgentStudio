import { expect, test } from '@playwright/test'
import { vapidSubject } from '../src/lib/notifications/notifications.server'

/**
 * The VAPID subject, which `web-push` is strict about.
 *
 * It accepts only an `https:` or `mailto:` subject and throws on anything else. This used
 * to receive `ORIGIN` verbatim, and that is a trap rather than an edge case: the README
 * tells operators to set `ORIGIN`, and the deployment target is a NAS on a LAN, so the
 * documented configuration is routinely `http://host:port`. Every push send then answered
 * 500 — including the "send test notification" button whose whole job is to tell the
 * operator whether push works.
 *
 * CI never saw it because `test.yml` sets no `ORIGIN` at all and took the fallback. It
 * showed up the first time the suite ran against a `.env` written the way the README says
 * to write one.
 */

test('an https origin is used as-is', () => {
	expect(vapidSubject('https://agentstudio.example')).toBe('https://agentstudio.example')
})

test('a mailto subject is used as-is', () => {
	expect(vapidSubject('mailto:ops@example.com')).toBe('mailto:ops@example.com')
})

test('a plain-http origin falls back instead of throwing', () => {
	// The case the README produces on a LAN deployment.
	expect(vapidSubject('http://127.0.0.1:4173')).toBe('mailto:AgentStudio@localhost')
	expect(vapidSubject('http://nas.local:3000')).toBe('mailto:AgentStudio@localhost')
})

test('an unset, empty or whitespace origin falls back', () => {
	expect(vapidSubject(undefined)).toBe('mailto:AgentStudio@localhost')
	expect(vapidSubject('')).toBe('mailto:AgentStudio@localhost')
	expect(vapidSubject('   ')).toBe('mailto:AgentStudio@localhost')
})

test('surrounding whitespace does not disqualify a good origin', () => {
	// A value copied into a .env with a trailing space is still what the operator meant.
	expect(vapidSubject('  https://agentstudio.example  ')).toBe('https://agentstudio.example')
})
