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
 *
 * The matchers here run on the calling thread with no time limit, so production code does
 * not call them on user rules: it goes through `scanForExclusions` in
 * `exclusion-scan.server.ts`, which applies the same rules, the same way, on a worker thread
 * with a time limit. They stay as the reference the scanner is specified against.
 */

export type ExclusionKind = 'regex' | 'substring'

export type ExclusionMatch = {
	ruleId: string | null
	ruleName: string
	/** The matched span, redacted — enough to explain the skip without echoing a secret. */
	sample: string
}

/** Patterns longer than this are rejected at save time. */
export const MAX_PATTERN_LENGTH = 400

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
	const nested = findNestedQuantifier(trimmed)
	if (nested) {
		return `"${nested}" repeats a group that already repeats inside, which can take practically forever to check on some text. Repeat only the inside, e.g. "(a+)+" → "a+".`
	}
	return null
}

/**
 * What the rules list says about a rule already saved, or null when the editor would accept it
 * today: the editor's complaint, plus what the rule does in the meantime. A rule saved before a
 * validation change keeps running — one that no longer compiles never matches, and any other
 * runs under the scanner's time limit.
 */
export function describeSavedRuleProblem(kind: ExclusionKind, pattern: string): string | null {
	const problem = validateExclusionPattern(kind, pattern)
	if (!problem) return null
	if (compileExclusionRule({ name: '', kind, pattern }).invalid) {
		return `${problem} Until it is fixed, this rule never matches.`
	}
	return `${problem} It still runs, but a turn it cannot finish checking in time is dropped.`
}

/**
 * The first repeated group that can split a run of text more than one way, or null when there
 * is none: a group repeated by `*`, `+` or `{n,…}` whose inside also repeats, where some
 * alternative has nothing that must appear between one repetition and the next — `(a+)+`,
 * `(\w+\s?)*`, `(\d+|x)+`.
 *
 * JavaScript's regex engine backtracks, and that shape is the classic way to make it try
 * exponentially many ways of splitting a run of text before giving up on a non-match: `(a+)+$`
 * against forty `a`s and a `!` does not finish. A rule is checked against every turn of every
 * conversation, so the rule editor refuses the shape outright. It is a cheap structural check,
 * not a proof — other slow patterns exist — which is why matching also runs under a time limit
 * (`exclusion-scan.server.ts`).
 *
 * Something that must appear each time keeps the repetitions apart, so `(?:[a-z0-9-]+\.)+com`
 * and `(\d{3}-)+` are fine: an unquantified atom, or one with a fixed count like `\d{3}`, is
 * such a delimiter. Inside a group, only a quantifier whose count can vary makes it repeat
 * (`*`, `+`, `{2,}`, `{1,3}`); `?` matches at most once.
 */
export function findNestedQuantifier(pattern: string): string | null {
	type Group = {
		start: number
		/** Something inside can match a varying number of times. */
		repeats: boolean
		/** Every alternative so far has something that must appear. */
		delimited: boolean
		/** The alternative being read has something that must appear. */
		branchDelimited: boolean
	}
	const open = (start: number): Group => ({ start, repeats: false, delimited: true, branchDelimited: false })
	const stack: Group[] = [open(0)]
	let i = 0

	while (i < pattern.length) {
		const frame = stack[stack.length - 1]
		const char = pattern[i]

		if (char === '(') {
			stack.push(open(i))
			i = skipGroupPrefix(pattern, i + 1)
			continue
		}
		if (char === '|') {
			frame.delimited &&= frame.branchDelimited
			frame.branchDelimited = false
			i += 1
			continue
		}
		// Zero-width: neither something to repeat nor something that must appear.
		if (char === '^' || char === '$' || (char === '\\' && (pattern[i + 1] === 'b' || pattern[i + 1] === 'B'))) {
			i += char === '\\' ? 2 : 1
			continue
		}

		// One atom: a closed group, an escape, a character class, or a single character.
		const start = i
		let group: Group | null = null
		if (char === ')') {
			if (stack.length === 1) {
				// Unbalanced; the compile check reports it.
				i += 1
				continue
			}
			group = stack.pop()!
			group.delimited &&= group.branchDelimited
			i += 1
		} else if (char === '\\') {
			i += 2
		} else if (char === '[') {
			// `]` straight after `[` (or `[^`) is part of the class, not its end.
			i += 1
			if (pattern[i] === '^') i += 1
			if (pattern[i] === ']') i += 1
			while (i < pattern.length && pattern[i] !== ']') i += pattern[i] === '\\' ? 2 : 1
			i += 1
		} else {
			i += 1
		}

		const parent = stack[stack.length - 1]
		const atomStart = group ? group.start : start
		// A group that must match something every time can delimit like a single character can.
		const mustAppear = group ? group.delimited : true
		if (group?.repeats) parent.repeats = true

		const quantifier = readQuantifier(pattern, i)
		if (!quantifier) {
			if (mustAppear) parent.branchDelimited = true
			continue
		}
		if (quantifier.max > 1 && group?.repeats && !group.delimited) {
			return pattern.slice(atomStart, i + quantifier.length)
		}
		if (quantifier.max > 1 && quantifier.max > quantifier.min) parent.repeats = true
		if (quantifier.min === quantifier.max && quantifier.min >= 1 && mustAppear) parent.branchDelimited = true
		i += quantifier.length
		// A lazy suffix (`+?`) is part of the quantifier.
		if (pattern[i] === '?') i += 1
	}
	return null
}

/** Past a group's prefix — `?:`, `?=`, `?!`, `?<=`, `?<!`, `?<name>` — so its `?` is not read as a quantifier. */
function skipGroupPrefix(pattern: string, at: number): number {
	if (pattern[at] !== '?') return at
	const next = pattern[at + 1]
	if (next === '<' && pattern[at + 2] !== '=' && pattern[at + 2] !== '!') {
		const close = pattern.indexOf('>', at)
		return close === -1 ? pattern.length : close + 1
	}
	return at + (next === '<' ? 3 : 2)
}

/** The quantifier starting at `at`, if any: its length and the counts it allows. */
function readQuantifier(pattern: string, at: number): { length: number; min: number; max: number } | null {
	const char = pattern[at]
	if (char === '*') return { length: 1, min: 0, max: Infinity }
	if (char === '+') return { length: 1, min: 1, max: Infinity }
	if (char === '?') return { length: 1, min: 0, max: 1 }
	if (char !== '{') return null
	// Without the `u` flag a `{` that does not form a quantifier is a literal brace.
	const braces = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(at))
	if (!braces) return null
	const min = Number(braces[1])
	const max = braces[2] === undefined ? min : braces[3] === '' ? Infinity : Number(braces[3])
	return { length: braces[0].length, min, max }
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
				const haystack = content.toLowerCase()
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
			const match = regex.exec(content)
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
