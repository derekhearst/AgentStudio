/**
 * AAAK (Address-Anchored Annotated Key) compressed pointer index.
 *
 * Ported from MemPalace's `mempalace/dialect.py`. AAAK gives each drawer a
 * dense, scannable address with semantic tags, while keeping the underlying
 * content verbatim. The encoder here is intentionally minimal — exact tag
 * extraction quality comes from the upstream LLM in mining.server.ts; this
 * module only formats the resulting structure into the canonical AAAK string.
 *
 * Canonical pointer:
 *   § W-042/R-11/D-007
 *   @p noah~son.age=6~dob=09-12
 *   @l glebe-pt-rd.park
 *   @e birthday~party(n≈8)
 *   @i therizinosaurus~claws
 *   @t 2026-04-14T09:41
 *
 * Tag families:
 *   p = people
 *   l = locations
 *   e = events
 *   i = items / interests
 *   t = timestamp(s)
 */

export type AaakTags = {
	p?: string[]
	l?: string[]
	e?: string[]
	i?: string[]
	t?: string[]
}

export type AaakIndex = {
	pointer: string
	tags: AaakTags
}

export type AaakAddress = {
	wing: number
	room: number
	drawer: number
}

const TAG_KEYS: Array<keyof AaakTags> = ['p', 'l', 'e', 'i', 't']

function pad(n: number, width: number): string {
	return String(n).padStart(width, '0')
}

export function formatAddress(address: AaakAddress): string {
	return `§ W-${pad(address.wing, 3)}/R-${pad(address.room, 2)}/D-${pad(address.drawer, 3)}`
}

/** Slug a token down to lowercase + hyphen for stable AAAK fragments. */
export function slugifyToken(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[\s_]+/g, '-')
		.replace(/[^a-z0-9~.=:()≈+/\-]/g, '')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '')
}

function normaliseTagValues(values: string[] | undefined): string[] {
	if (!values || values.length === 0) return []
	const seen = new Set<string>()
	const out: string[] = []
	for (const raw of values) {
		const slug = slugifyToken(raw)
		if (!slug || seen.has(slug)) continue
		seen.add(slug)
		out.push(slug)
	}
	return out
}

export function encodeAaak(address: AaakAddress, tags: AaakTags): AaakIndex {
	const lines: string[] = [formatAddress(address)]
	const cleanTags: AaakTags = {}
	for (const key of TAG_KEYS) {
		const values = normaliseTagValues(tags[key])
		if (values.length === 0) continue
		cleanTags[key] = values
		lines.push(`@${key} ${values.join('~')}`)
	}
	return { pointer: lines.join('\n'), tags: cleanTags }
}

const ADDRESS_RE = /^§\s+W-(\d+)\/R-(\d+)\/D-(\d+)/
const TAG_RE = /^@([plei t])\s+(.+)$/

export function decodeAaak(pointer: string): { address: AaakAddress; tags: AaakTags } {
	const lines = pointer.split(/\r?\n/).filter((line) => line.trim().length > 0)
	if (lines.length === 0) {
		throw new Error('Empty AAAK pointer')
	}
	const head = lines[0].match(ADDRESS_RE)
	if (!head) {
		throw new Error(`Invalid AAAK address line: ${lines[0]}`)
	}
	const address: AaakAddress = {
		wing: Number(head[1]),
		room: Number(head[2]),
		drawer: Number(head[3]),
	}
	const tags: AaakTags = {}
	for (let i = 1; i < lines.length; i += 1) {
		const match = lines[i].match(TAG_RE)
		if (!match) continue
		const key = match[1].trim() as keyof AaakTags
		tags[key] = match[2]
			.split('~')
			.map((value) => value.trim())
			.filter(Boolean)
	}
	return { address, tags }
}

/** Render only the body tag lines (no address) — used for retrieval keyword boost. */
export function aaakKeywords(index: AaakIndex): string {
	const tokens: string[] = []
	for (const key of TAG_KEYS) {
		for (const value of index.tags[key] ?? []) {
			tokens.push(value.replace(/[~.=()]/g, ' '))
		}
	}
	return tokens.join(' ')
}
