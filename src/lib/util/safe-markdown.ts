import type { Token, Tokens } from 'marked'

/**
 * The pieces every `marked` renderer in this app needs before its output can go into
 * `{@html}`.
 *
 * Everything we render as markdown is untrusted: model replies, thinking, subagent
 * output, and files the agent wrote. Any of it can carry text lifted from a web page or a
 * repo the agent read, which is exactly where a prompt injection lives. Stock `marked`
 * passes raw HTML through, keeps `javascript:` links, and loads any image URL, so its
 * output in our origin is stored XSS and a zero-click exfiltration channel.
 *
 * The rules, which the renderers in `chat/chat.ts` and `chat-console/preview-render.ts`
 * build on:
 *
 * - Raw HTML is escaped, never emitted. The chat allows a handful of attribute-less
 *   formatting tags (`<br>`, `<b>`, …) through `allowedInlineTag`, rebuilt from their
 *   name so nothing the model wrote reaches an attribute.
 * - *All* text is escaped, including the text `marked` itself leaves raw. After an inline
 *   `<pre>`, `<code>`, `<kbd>` or `<script>` tag the lexer switches to raw mode and emits
 *   the following text unescaped, so `<kbd>x <img src=x onerror=…>` gets a live `<img>`
 *   through even when the `html` renderer escapes every tag. `sanitizedText` closes that.
 * - Links must be http, https, mailto, or relative to our own origin.
 * - Images from anywhere but our own origin are not loaded automatically.
 */

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

/**
 * Escape text content the way `marked` does: every `<`, `>` and quote, and every `&`
 * that does not already start an entity. Leaving entities alone keeps `&rarr;` an arrow,
 * and is safe in text content, where an entity can only ever decode to text.
 */
export function escapeText(value: string): string {
	return value
		.replace(/&(?!#?\w+;)/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

/**
 * Formatting tags a model reasonably writes inline — `<br>` in a table cell above all.
 * `kbd`, `code` and `pre` are left out on purpose: they flip `marked`'s lexer into raw
 * mode, so they are safer shown than rendered.
 */
const INLINE_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'del', 'ins', 'sub', 'sup', 'mark', 'small', 'br'])
const BARE_TAG = /^<(\/?)([a-z]+)\s*(\/?)>$/i

/**
 * The canonical form of an allowed, attribute-less tag, or null. The tag is rebuilt from
 * its name rather than passed through, so there is nothing an attacker controls in it.
 */
export function allowedInlineTag(raw: string): string | null {
	const match = BARE_TAG.exec(raw.trim())
	if (!match) return null
	const [, closing, name, selfClosing] = match
	const tag = name.toLowerCase()
	if (!INLINE_TAGS.has(tag)) return null
	if (tag === 'br') return closing ? null : '<br>'
	if (selfClosing) return null
	return closing ? `</${tag}>` : `<${tag}>`
}

type ParserThis = { parser: { parseInline(tokens: Token[]): string } }

/**
 * `text` renderer that escapes everything, including the raw-mode text `marked` would
 * emit verbatim (see the module note). Install it on every renderer that feeds `{@html}`.
 */
export function sanitizedText(this: ParserThis, token: Tokens.Text | Tokens.Escape): string {
	if ('tokens' in token && token.tokens) return this.parser.parseInline(token.tokens)
	return escapeText(token.text)
}

/** Stands in for our origin when classifying a URL; never emitted. */
const SENTINEL_ORIGIN = 'https://agentstudio.invalid'
const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

export type SafeUrl = {
	/** The href to emit (escape it with `escapeHtml`, which is what makes it exact). */
	href: string
	/** True when it leaves our origin, so it should open in a new tab without a referrer. */
	external: boolean
}

/**
 * Named references worth decoding in a URL. Anything not listed is left as literal text,
 * and since the emitted href has every `&` escaped, the browser sees it literally too.
 */
const URL_NAMED_REFERENCES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	colon: ':',
	sol: '/',
	lpar: '(',
	rpar: ')',
	Tab: '\t',
	NewLine: '\n',
}

/** CommonMark decodes character references in a link destination; so do we, before judging it. */
function decodeCharacterReferences(value: string): string {
	return value.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[A-Za-z]+);/g, (match, ref: string) => {
		if (ref.startsWith('#')) {
			const hex = ref[1] === 'x' || ref[1] === 'X'
			const codePoint = Number.parseInt(ref.slice(hex ? 2 : 1), hex ? 16 : 10)
			return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '�'
		}
		return URL_NAMED_REFERENCES[ref] ?? match
	})
}

/**
 * Classify a markdown link destination, or refuse it.
 *
 * The check runs on the string the browser will use, not on a guess at it. Character
 * references are decoded first (so `javascript&#58;` is judged as `javascript:`), tabs
 * and newlines are dropped and surrounding control characters trimmed exactly as the URL
 * parser does, and anything else below U+0020 is refused. The caller then escapes every
 * `&` when emitting it, so the browser cannot decode a second, different URL out of it.
 */
export function safeUrl(raw: string | null | undefined): SafeUrl | null {
	if (!raw) return null
	const href = decodeCharacterReferences(raw)
		.replace(/[\t\n\r]/g, '')
		.replace(/^[\u0000- ]+|[\u0000- ]+$/g, '')
	if (!href || /[\u0000-\u001f\u007f]/.test(href)) return null
	let url: URL
	try {
		url = new URL(href, `${SENTINEL_ORIGIN}/`)
	} catch {
		return null
	}
	if (!LINK_PROTOCOLS.has(url.protocol)) return null
	// `mailto:` has an opaque origin: not ours, but not a page to open in a tab either.
	return { href, external: url.protocol !== 'mailto:' && url.origin !== SENTINEL_ORIGIN }
}

/** An image source we will load without asking: our own origin only. */
export function sameOriginImageSrc(raw: string | null | undefined): string | null {
	const url = safeUrl(raw)
	if (!url || url.external || /^mailto:/i.test(url.href)) return null
	return url.href
}

/**
 * Hostile inputs every sanitizing renderer must neutralise, paired with what must not
 * appear in its output. Used by the renderers' self-checks and pinned by the specs.
 */
export const SANITIZER_PROBES: ReadonlyArray<{ input: string; forbidden: RegExp }> = [
	{ input: '<img src=x onerror=alert(1)>', forbidden: /<img/i },
	{ input: '<kbd>x <img src=x onerror=alert(1)//', forbidden: /<img/i },
	{ input: '<script>alert(1)</script>', forbidden: /<script/i },
	{ input: '[a](javascript:alert(1))', forbidden: /href="\s*javascript:/i },
	{ input: '<javascript:alert(1)>', forbidden: /href="\s*javascript:/i },
]

/** True when `render` neutralises every probe. A renderer that fails this must not be used. */
export function sanitizerHolds(render: (source: string) => string): boolean {
	try {
		return SANITIZER_PROBES.every(({ input, forbidden }) => !forbidden.test(render(input)))
	} catch {
		return false
	}
}
