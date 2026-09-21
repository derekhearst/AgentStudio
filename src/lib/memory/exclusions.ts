/**
 * Exclusion rules — pure matching engine.
 *
 * This is the deny list the miner consults *before* it embeds or inserts. Ordering
 * matters for safety: a turn that matches an enabled rule is dropped in
 * `mining.server.ts` before `embed()` runs, so excluded content never leaves the process
 * and never reaches `memory_drawers`. A drawer that captured a secret is not hypothetical
 * — this repo has had a password sitting in a checked-in file — so the built-in rules
 * below ship enabled for every user.
 *
 * Everything here is pure and dependency-free so the matching behaviour can be unit
 * tested without a database. The DB-backed half lives in `exclusions.server.ts`.
 */

export type ExclusionKind = 'regex' | 'substring'

export type ExclusionMatch = {
	ruleId: string | null
	ruleName: string
	/** The matched span, redacted — enough to explain the skip without echoing a secret. */
	sample: string
}

/** Patterns longer than this are rejected at save time (cheap ReDoS guard). */
export const MAX_PATTERN_LENGTH = 400
/** Content beyond this length is not scanned character-by-character by user regexes. */
export const MAX_SCAN_CHARS = 40_000

export type BuiltinExclusionRule = {
	name: string
	description: string
	kind: ExclusionKind
	pattern: string
}

/**
 * Credential-shaped content. Each rule is deliberately narrow: a false positive costs one
 * forgotten turn, a false negative costs a secret memorised forever and replayed into
 * every future prompt.
 */
export const BUILTIN_EXCLUSION_RULES: BuiltinExclusionRule[] = [
	{
		name: 'Secret assignment',
		description: 'password / api key / token / secret followed by a value',
		kind: 'regex',
		pattern:
			'(?:pass(?:word|wd)?|pwd|secret|api[_\\- ]?key|access[_\\- ]?token|auth[_\\- ]?token|client[_\\- ]?secret|private[_\\- ]?key)\\s*(?:[:=]|is)\\s*\\S{4,}',
	},
	{
		name: 'AWS access key id',
		description: 'AKIA/ASIA-prefixed access key identifiers',
		kind: 'regex',
		pattern: '\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b',
	},
	{
		name: 'Provider API key',
		description: 'sk-/pk- style keys used by OpenAI, OpenRouter, Anthropic, Stripe',
		kind: 'regex',
		pattern: '\\b(?:sk|pk|rk)-[A-Za-z0-9_\\-]{16,}\\b',
	},
	{
		name: 'GitHub token',
		description: 'ghp_/gho_/ghu_/ghs_/ghr_ personal access and app tokens',
		kind: 'regex',
		pattern: '\\bgh[pousr]_[A-Za-z0-9]{20,}\\b',
	},
	{
		name: 'Private key block',
		description: 'PEM-armoured private keys',
		kind: 'regex',
		pattern: '-----BEGIN [A-Z ]*PRIVATE KEY-----',
	},
	{
		name: 'JSON web token',
		description: 'three base64url segments in JWT shape',
		kind: 'regex',
		pattern: '\\beyJ[A-Za-z0-9_\\-]{8,}\\.[A-Za-z0-9_\\-]{8,}\\.[A-Za-z0-9_\\-]{8,}\\b',
	},
	{
		name: 'Connection string credentials',
		description: 'scheme://user:password@host URLs (Postgres, Redis, Mongo, …)',
		kind: 'regex',
		pattern: '\\b[a-z][a-z0-9+.\\-]*://[^\\s/:@]+:[^\\s/@]{3,}@',
	},
]

export type CompiledExclusionRule = {
	id: string | null
	name: string
	kind: ExclusionKind
	pattern: string
	/** True when the pattern failed to compile; such a rule never matches. */
	invalid: boolean
	test: (content: string) => string | null
}

/**
 * Validate a pattern without compiling it into the live rule set. Returns an error string
 * when the pattern is unusable, `null` when it is fine.
 */
export function validateExclusionPattern(kind: ExclusionKind, pattern: string): string | null {
	const trimmed = pattern.trim()
	if (trimmed.length === 0) return 'Pattern is empty.'
	if (trimmed.length > MAX_PATTERN_LENGTH) return `Pattern is longer than ${MAX_PATTERN_LENGTH} characters.`
	if (kind === 'substring') return null
	try {
		void new RegExp(trimmed, 'i')
	} catch (error) {
		return `Invalid regular expression: ${(error as Error).message}`
	}
	return null
}

/**
 * Compile a rule into a matcher. An invalid regex compiles to a matcher that never fires
 * (flagged `invalid`) rather than throwing mid-mine — a broken rule must not wedge mining.
 */
export function compileExclusionRule(rule: {
	id?: string | null
	name: string
	kind: ExclusionKind
	pattern: string
}): CompiledExclusionRule {
	const pattern = rule.pattern.trim()

	if (rule.kind === 'substring') {
		const needle = pattern.toLowerCase()
		return {
			id: rule.id ?? null,
			name: rule.name,
			kind: 'substring',
			pattern,
			invalid: needle.length === 0,
			test: (content: string) => {
				if (needle.length === 0) return null
				const haystack = content.slice(0, MAX_SCAN_CHARS).toLowerCase()
				const at = haystack.indexOf(needle)
				return at === -1 ? null : content.slice(at, at + needle.length)
			},
		}
	}

	let regex: RegExp | null = null
	try {
		// Case-insensitive, never global: a `g` flag would carry `lastIndex` between calls
		// and make matching depend on scan order.
		regex = new RegExp(pattern, 'i')
	} catch {
		regex = null
	}

	return {
		id: rule.id ?? null,
		name: rule.name,
		kind: 'regex',
		pattern,
		invalid: regex === null,
		test: (content: string) => {
			if (!regex) return null
			const match = regex.exec(content.slice(0, MAX_SCAN_CHARS))
			return match ? match[0] : null
		},
	}
}

export function compileExclusionRules(
	rules: Array<{ id?: string | null; name: string; kind: ExclusionKind; pattern: string; enabled?: boolean }>,
): CompiledExclusionRule[] {
	return rules.filter((rule) => rule.enabled !== false).map((rule) => compileExclusionRule(rule))
}

/**
 * Redact the matched span so a skip can be explained without echoing the secret.
 * Only a short leading fragment survives — never the tail, which for key-shaped values is
 * the part worth guarding — plus the length, which is what makes the match identifiable.
 */
export function redactSample(sample: string): string {
	const collapsed = sample.replace(/\s+/g, ' ').trim()
	const head = collapsed.slice(0, collapsed.length <= 12 ? 4 : 8)
	return `${head}… (${collapsed.length} chars)`
}

/** First matching rule for this content, or null when nothing matches. */
export function findExclusionMatch(content: string, rules: CompiledExclusionRule[]): ExclusionMatch | null {
	for (const rule of rules) {
		const hit = rule.test(content)
		if (hit !== null) {
			return { ruleId: rule.id, ruleName: rule.name, sample: redactSample(hit) }
		}
	}
	return null
}

/** The built-in credential rules, compiled and ready to match. Used by tests and previews. */
export function compileBuiltinExclusionRules(): CompiledExclusionRule[] {
	return BUILTIN_EXCLUSION_RULES.map((rule) => compileExclusionRule(rule))
}
