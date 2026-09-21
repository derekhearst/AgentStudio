import { expect, test } from '@playwright/test'
import {
	BUILTIN_EXCLUSION_RULES,
	compileBuiltinExclusionRules,
	compileExclusionRule,
	compileExclusionRules,
	findExclusionMatch,
	MAX_PATTERN_LENGTH,
	redactSample,
	validateExclusionPattern,
} from '../src/lib/memory/exclusions'

/**
 * Pure-function unit tests for the memory exclusion engine (issue #37). No DB, no browser.
 *
 * These are the guardrail that stops a credential becoming a drawer, so the built-in
 * patterns get explicit positive and negative cases rather than a smoke test.
 */

const builtins = compileBuiltinExclusionRules()

test.describe('memory/exclusions — built-in credential rules', () => {
	const shouldBlock: Array<[string, string]> = [
		['Secret assignment', 'the db password = hunter2trombone'],
		['Secret assignment', 'API_KEY: 9f2c1a44bb90'],
		['Secret assignment', 'my openrouter api key is abcd1234efgh'],
		['AWS access key id', 'creds are AKIAIOSFODNN7EXAMPLE for the bucket'],
		['Provider API key', 'use sk-or-v1-0123456789abcdefghij when calling it'],
		['GitHub token', 'token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 works'],
		['Private key block', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNza'],
		[
			'JSON web token',
			'bearer eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NTY3.SflKxwRJSMeKKF2QT4fwpM',
		],
		['Connection string credentials', 'DATABASE_URL=postgresql://derek:hunter2@192.168.0.2:5432/AgentStudio'],
	]

	for (const [expectedRule, content] of shouldBlock) {
		test(`blocks ${expectedRule.toLowerCase()}: ${content.slice(0, 32)}…`, () => {
			const match = findExclusionMatch(content, builtins)
			expect(match, `expected a rule to block: ${content}`).not.toBeNull()
			expect(match?.ruleName).toBe(expectedRule)
		})
	}

	const shouldPass = [
		'I prefer the aisle seat on long flights.',
		'We decided to use Postgres 17 for the new service.',
		'The password reset email never arrived — support ticket 4412.',
		'Remember that my son Noah turns 7 in September.',
		'https://github.com/derekhearst/AgentStudio/pull/46 is the one to review',
	]

	for (const content of shouldPass) {
		test(`lets ordinary memory through: ${content.slice(0, 32)}…`, () => {
			expect(findExclusionMatch(content, builtins)).toBeNull()
		})
	}

	test('every built-in pattern compiles', () => {
		for (const rule of BUILTIN_EXCLUSION_RULES) {
			expect(validateExclusionPattern(rule.kind, rule.pattern), `rule ${rule.name}`).toBeNull()
			expect(compileExclusionRule(rule).invalid, `rule ${rule.name}`).toBe(false)
		}
	})

	test('a "password reset" mention is not treated as a secret assignment', () => {
		// The rule requires a value after `=`/`:`/`is`, so prose about passwords survives.
		expect(findExclusionMatch('Can you walk me through the password reset flow?', builtins)).toBeNull()
	})
})

test.describe('memory/exclusions — matching semantics', () => {
	test('substring rules are case-insensitive and report the matched span', () => {
		const rules = compileExclusionRules([
			{ id: 'r1', name: 'Home address', kind: 'substring', pattern: '12 Glebe Point Rd' },
		])
		const match = findExclusionMatch('Deliver it to 12 GLEBE POINT RD please', rules)
		expect(match?.ruleId).toBe('r1')
		expect(match?.ruleName).toBe('Home address')
	})

	test('disabled rules are dropped at compile time', () => {
		const rules = compileExclusionRules([
			{ id: 'r1', name: 'Off', kind: 'substring', pattern: 'secret sauce', enabled: false },
			{ id: 'r2', name: 'On', kind: 'substring', pattern: 'other thing', enabled: true },
		])
		expect(rules).toHaveLength(1)
		expect(findExclusionMatch('the secret sauce recipe', rules)).toBeNull()
	})

	test('an invalid regex is flagged and never matches instead of throwing', () => {
		const rule = compileExclusionRule({ id: 'bad', name: 'Broken', kind: 'regex', pattern: '([unclosed' })
		expect(rule.invalid).toBe(true)
		expect(() => findExclusionMatch('anything at all', [rule])).not.toThrow()
		expect(findExclusionMatch('anything at all', [rule])).toBeNull()
	})

	test('the first matching rule wins, in list order', () => {
		const rules = compileExclusionRules([
			{ id: 'a', name: 'First', kind: 'substring', pattern: 'token' },
			{ id: 'b', name: 'Second', kind: 'substring', pattern: 'token' },
		])
		expect(findExclusionMatch('my token here', rules)?.ruleName).toBe('First')
	})

	test('regex matching has no sticky state between calls', () => {
		// A `g` flag would carry lastIndex and make the second call miss.
		const rules = compileExclusionRules([{ id: 'r', name: 'Digits', kind: 'regex', pattern: '\\d{4}' }])
		expect(findExclusionMatch('code 1234', rules)).not.toBeNull()
		expect(findExclusionMatch('code 1234', rules)).not.toBeNull()
	})

	test('empty rule sets never block anything', () => {
		expect(findExclusionMatch('DATABASE_URL=postgres://u:p@h/db', [])).toBeNull()
	})
})

test.describe('memory/exclusions — validation and redaction', () => {
	test('rejects an empty pattern', () => {
		expect(validateExclusionPattern('regex', '   ')).toContain('empty')
	})

	test('rejects an over-long pattern as a ReDoS guard', () => {
		const tooLong = 'a'.repeat(MAX_PATTERN_LENGTH + 1)
		expect(validateExclusionPattern('regex', tooLong)).toContain('longer than')
	})

	test('rejects an uncompilable regex but accepts any substring', () => {
		expect(validateExclusionPattern('regex', '([unclosed')).toContain('Invalid regular expression')
		expect(validateExclusionPattern('substring', '([unclosed')).toBeNull()
	})

	test('redaction keeps only a leading fragment, never the tail', () => {
		const secret = 'sk-or-v1-0123456789abcdefghij'
		const redacted = redactSample(secret)
		expect(redacted).toContain('…')
		expect(redacted).toContain('sk-or-v1')
		expect(redacted).not.toContain('0123456789')
		// The tail is what matters for key-shaped values, so it must not survive.
		expect(redacted).not.toContain('ghij')
		expect(redacted).toContain(`${secret.length} chars`)
	})

	test('redaction collapses whitespace so a multi-line match stays one line', () => {
		expect(redactSample('password  =\n  hunter2trombone')).not.toContain('\n')
	})
})
