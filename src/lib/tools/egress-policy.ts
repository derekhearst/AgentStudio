/**
 * Where the web-reading tools are allowed to go: the public internet, and nothing else.
 *
 * `web_fetch`, `pdf_read`, `browser_screenshot` and the research loop's page reads all take a
 * URL from the model — and through the model, from whatever page or search result it read
 * last — so every one of those URLs is untrusted. None of them may reach loopback, the LAN,
 * the cloud metadata endpoint or the container network the server runs on.
 *
 * This is the pure half: it classifies an address, a host name or a URL and does no I/O, so
 * the whole table can be pinned by a unit spec. It is NOT a guard on its own. A public name
 * can resolve to a private address and a public URL can redirect to one; `egress.server.ts`
 * applies this policy to every address a name resolves to and to every redirect hop, and
 * nothing should reach the network on the strength of `validateEgressUrl` alone.
 */

export type EgressCheck = { ok: true; url: URL } | { ok: false; error: string }

/**
 * IPv4 ranges that are not the public internet (RFC 6890 special-purpose registry, plus
 * multicast and the reserved class-E block). A request to any of them is refused.
 */
const IPV4_BLOCKED: ReadonlyArray<readonly [base: string, prefix: number, what: string]> = [
	['0.0.0.0', 8, '"this network" / unspecified'],
	['10.0.0.0', 8, 'private network'],
	['100.64.0.0', 10, 'carrier-grade NAT / Tailscale'],
	['127.0.0.0', 8, 'loopback'],
	['169.254.0.0', 16, 'link-local (cloud metadata)'],
	['172.16.0.0', 12, 'private network'],
	['192.0.0.0', 24, 'IETF protocol assignments'],
	['192.0.2.0', 24, 'documentation'],
	['192.88.99.0', 24, '6to4 relay'],
	['192.168.0.0', 16, 'private network'],
	['198.18.0.0', 15, 'benchmarking'],
	['198.51.100.0', 24, 'documentation'],
	['203.0.113.0', 24, 'documentation'],
	['224.0.0.0', 4, 'multicast'],
	['240.0.0.0', 4, 'reserved / broadcast'],
]

/**
 * Name suffixes that only ever mean "a machine on this network": RFC 6761 `localhost`, mDNS
 * `.local`, ICANN's private-use `.internal`, RFC 8375 `home.arpa`, and the conventional
 * `.localdomain`. DNS would usually catch these too; refusing them by name gives a clearer
 * error and does not depend on what the resolver happens to say.
 */
const PRIVATE_SUFFIXES = ['localhost', 'local', 'internal', 'home.arpa', 'localdomain']

/** Strict dotted quad — the only IPv4 form left once the WHATWG URL parser has normalised it. */
export function parseIPv4(input: string): number[] | null {
	const parts = input.split('.')
	if (parts.length !== 4) return null
	const bytes: number[] = []
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null
		const n = Number(part)
		if (n > 255) return null
		bytes.push(n)
	}
	return bytes
}

/**
 * Sixteen bytes, or null when this is not an IPv6 literal. Accepts the bracketed URL form,
 * `::` compression and an embedded dotted-quad tail (`::ffff:127.0.0.1`); a zone id
 * (`fe80::1%eth0`, as DNS can return) is dropped, since it does not change the address class.
 */
export function parseIPv6(input: string): number[] | null {
	let s = input
	if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
	const zone = s.indexOf('%')
	if (zone !== -1) s = s.slice(0, zone)
	if (!s.includes(':')) return null

	let v4Tail: number[] | null = null
	const lastColon = s.lastIndexOf(':')
	if (s.slice(lastColon + 1).includes('.')) {
		v4Tail = parseIPv4(s.slice(lastColon + 1))
		if (!v4Tail) return null
		// Two placeholder groups hold the tail's place; its bytes are written in below.
		s = `${s.slice(0, lastColon + 1)}0:0`
	}

	const halves = s.split('::')
	if (halves.length > 2) return null
	const split = (part: string) => (part === '' ? [] : part.split(':'))
	const head = split(halves[0])
	const tail = halves.length === 2 ? split(halves[1]) : []
	let groups: string[]
	if (halves.length === 1) {
		if (head.length !== 8) return null
		groups = head
	} else {
		if (head.length + tail.length > 7) return null
		groups = [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail]
	}

	const bytes: number[] = []
	for (const group of groups) {
		if (!/^[0-9a-f]{1,4}$/i.test(group)) return null
		const n = parseInt(group, 16)
		bytes.push(n >> 8, n & 0xff)
	}
	if (v4Tail) bytes.splice(12, 4, ...v4Tail)
	return bytes
}

function ipv4Reason(bytes: number[]): string | null {
	const value = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0
	for (const [base, prefix, what] of IPV4_BLOCKED) {
		const b = parseIPv4(base)!
		const baseValue = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0
		const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
		if ((value & mask) === (baseValue & mask)) return what
	}
	return null
}

function ipv6Reason(b: number[]): string | null {
	const zeroes = (from: number, to: number) => b.slice(from, to).every((x) => x === 0)

	// Forms that carry an IPv4 address inside them. The packet ends up at that IPv4 address,
	// so it is the one that has to be public: `[::ffff:127.0.0.1]` is loopback, not IPv6.
	if (zeroes(0, 10) && b[10] === 0xff && b[11] === 0xff) {
		const inner = ipv4Reason(b.slice(12))
		return inner && `IPv4-mapped ${inner}`
	}
	if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeroes(4, 12)) {
		const inner = ipv4Reason(b.slice(12))
		return inner && `NAT64 ${inner}`
	}
	if (b[0] === 0x20 && b[1] === 0x02) {
		const inner = ipv4Reason(b.slice(2, 6))
		return inner && `6to4 ${inner}`
	}

	// Only global unicast (2000::/3) is the public internet. Everything outside it is local
	// by definition; name the common ones so the error says what was hit.
	if ((b[0] & 0xe0) !== 0x20) {
		if (zeroes(0, 16)) return 'unspecified'
		if (zeroes(0, 15) && b[15] === 1) return 'loopback'
		if (zeroes(0, 12)) return 'IPv4-compatible (deprecated)'
		if ((b[0] & 0xfe) === 0xfc) return 'unique local (private network)'
		if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return 'link-local'
		if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return 'site-local (deprecated)'
		if (b[0] === 0xff) return 'multicast'
		return 'not a global unicast address'
	}

	// Special-purpose blocks inside 2000::/3.
	if (b[0] === 0x20 && b[1] === 0x01 && (b[2] & 0xfe) === 0x00) return 'IETF special-purpose (Teredo, benchmarking, ORCHID)'
	if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return 'documentation'
	if (b[0] === 0x3f && b[1] === 0xff && (b[2] & 0xf0) === 0x00) return 'documentation'
	return null
}

/**
 * Why this IP address is off-limits, or null when it is a public address. Anything that is
 * not a well-formed IPv4 or IPv6 address is refused too — this is only ever called on
 * something that is supposed to be an address, and "could not tell" must not mean "allowed".
 */
export function blockedAddressReason(address: string): string | null {
	const v4 = parseIPv4(address)
	if (v4) return ipv4Reason(v4)
	const v6 = parseIPv6(address)
	if (v6) return ipv6Reason(v6)
	return 'not an IP address'
}

/** Lower-cased, brackets and trailing dots removed: `LOCALHOST.` and `[::1]` compare as themselves. */
export function normalizeHost(host: string): string {
	let h = host.trim().toLowerCase()
	if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
	return h.replace(/\.+$/, '')
}

export function isIpLiteral(host: string): boolean {
	const h = normalizeHost(host)
	return parseIPv4(h) !== null || parseIPv6(h) !== null
}

/**
 * Why this host (a name or an address literal, as it appears in a URL) is off-limits, or
 * null when it may be looked up. A name that passes here can still resolve somewhere
 * private — that is checked at connect time by `guardedLookup`.
 */
export function blockedHostnameReason(host: string): string | null {
	const h = normalizeHost(host)
	if (!h) return 'empty host'
	if (isIpLiteral(h)) return blockedAddressReason(h)
	// A single label ("router", "postgres") only resolves through a local search domain or
	// the container network's DNS, never to a public site.
	if (!h.includes('.')) return 'single-label name, only resolves on a private network'
	for (const suffix of PRIVATE_SUFFIXES) {
		if (h === suffix || h.endsWith(`.${suffix}`)) return `".${suffix}" name, only resolves on a private network`
	}
	return null
}

/**
 * The URL-shaped check: http(s) only, and a host that is not private by its spelling.
 *
 * The WHATWG parser has already canonicalised the host by the time we look at it, which
 * matters: `http://2130706433/`, `http://0x7f.1/` and `http://127.1/` all come out as
 * `127.0.0.1`, and `http://[::ffff:127.0.0.1]/` as `[::ffff:7f00:1]`.
 */
export function validateEgressUrl(input: string | URL): EgressCheck {
	let url: URL
	try {
		url = new URL(typeof input === 'string' ? input.trim() : input.href)
	} catch {
		return { ok: false, error: 'invalid URL' }
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return { ok: false, error: `unsupported protocol "${url.protocol}" (only http/https allowed)` }
	}
	if (!url.hostname) return { ok: false, error: 'URL has no host' }
	const reason = blockedHostnameReason(url.hostname)
	if (reason) {
		return { ok: false, error: `Blocked: "${url.hostname}" is not a public address (${reason})` }
	}
	return { ok: true, url }
}
