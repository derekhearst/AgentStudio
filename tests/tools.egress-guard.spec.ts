/**
 * The egress guard behind web_fetch, pdf_read, browser_screenshot and the research loop.
 *
 * No database, no dev server, no internet: the policy is pure, and the network half runs
 * against a fixture HTTP server on loopback (see `egress-fixture.ts` for how the specs reach
 * a loopback fixture through a guard whose whole job is to refuse loopback).
 *
 * What is pinned:
 *   - every bypass the audit found (#37, #90): IPv4-mapped IPv6, `[::]`, `localhost.`, short
 *     ULA, CGNAT, numeric IPv4 spellings, names that resolve privately, and redirects
 *   - the rest of the special-purpose table, and the edges of each range
 *   - redirects are followed by hand and each hop re-checked, including by DNS
 *   - the byte cap (declared and streamed, and after decompression) and the deadline (#43)
 *   - the proxy the browser runs behind refuses private targets for plain HTTP and CONNECT
 */

import { expect, test } from '@playwright/test'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import http from 'node:http'
import type { LookupFunction } from 'node:net'
import type net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	blockedAddressReason,
	blockedHostnameReason,
	parseIPv6,
	validateEgressUrl,
} from '../src/lib/tools/egress-policy'
import {
	EGRESS_REFUSAL_HEADER,
	EgressBlockedError,
	EgressTooLargeError,
	assertPublicUrl,
	createEgressProxy,
	createGuardedLookup,
	guardedDownload,
	guardedGet,
	type EgressProxy,
} from '../src/lib/tools/egress.server'
import { DNS_TABLE, FIXTURE_HOST, fakeResolver, fixtureLookup, startFixture, type Fixture } from './egress-fixture'

// ── Policy ───────────────────────────────────────────────────────────────────────

test.describe('egress policy — URLs', () => {
	test('public http(s) URLs pass', () => {
		for (const url of [
			'https://example.com/path',
			'http://93.184.216.34/',
			'http://[2606:4700:4700::1111]/',
			// IPv4-mapped and 6to4 forms are judged by the IPv4 address inside them.
			'http://[::ffff:8.8.8.8]/',
			'http://[2002:808:808::1]/',
			'https://sub.example.co.uk:8443/a?b=c',
		]) {
			expect(validateEgressUrl(url).ok, url).toBe(true)
		}
	})

	test('every bypass from the audit is refused', () => {
		for (const url of [
			// IPv4-mapped IPv6 (the WHATWG parser rewrites these to [::ffff:7f00:1] etc.)
			'http://[::ffff:127.0.0.1]:5432/',
			'http://[::ffff:169.254.169.254]/latest/meta-data/',
			'http://[::ffff:10.0.0.1]/',
			// unspecified
			'http://[::]/',
			'http://0.0.0.0/',
			// trailing-dot and upper-case localhost
			'http://localhost./',
			'http://LOCALHOST:8080/',
			'http://foo.localhost/',
			// ULA whose second group is non-zero (the old regex needed `fd..::`)
			'http://[fd12:3456::1]/',
			'http://[fc00:1:2::3]/',
			// CGNAT / Tailscale
			'http://100.64.0.1/',
			'http://100.100.100.100/',
			'http://100.127.255.255/',
		]) {
			expect(validateEgressUrl(url).ok, url).toBe(false)
		}
	})

	test('numeric IPv4 spellings are refused (the URL parser canonicalises them)', () => {
		for (const url of ['http://2130706433/', 'http://0x7f.1/', 'http://127.1/', 'http://017700000001/', 'http://0x7f000001/']) {
			const result = validateEgressUrl(url)
			expect(result.ok, url).toBe(false)
			if (!result.ok) expect(result.error).toContain('127.0.0.1')
		}
	})

	test('the rest of the special-purpose table is refused', () => {
		for (const url of [
			'http://127.0.0.1/',
			'http://10.255.255.255/',
			'http://172.16.0.1/',
			'http://172.31.255.255/',
			'http://192.168.1.1/',
			'http://169.254.169.254/',
			'http://192.0.0.8/',
			'http://192.0.2.1/',
			'http://198.18.0.1/',
			'http://198.19.255.255/',
			'http://198.51.100.1/',
			'http://203.0.113.1/',
			'http://224.0.0.1/',
			'http://239.255.255.250/',
			'http://240.0.0.1/',
			'http://255.255.255.255/',
			'http://[::1]/',
			'http://[::127.0.0.1]/', // IPv4-compatible
			'http://[64:ff9b::a9fe:a9fe]/', // NAT64 → 169.254.169.254
			'http://[2002:7f00:1::]/', // 6to4 → 127.0.0.1
			'http://[2002:c0a8:101::1]/', // 6to4 → 192.168.1.1
			'http://[fe80::1]/',
			'http://[fec0::1]/',
			'http://[ff02::1]/',
			'http://[2001:db8::1]/',
			'http://[2001::1]/', // Teredo
			'http://[3fff::1]/',
			'http://[100::1]/', // discard-only
		]) {
			expect(validateEgressUrl(url).ok, url).toBe(false)
		}
	})

	test('range edges: the addresses either side of a blocked range are public', () => {
		for (const address of ['100.63.255.255', '100.128.0.0', '172.15.255.255', '172.32.0.0', '169.253.255.255', '198.17.255.255', '198.20.0.0', '223.255.255.255', '1.1.1.1']) {
			expect(blockedAddressReason(address), address).toBeNull()
		}
		for (const address of ['100.64.0.0', '172.16.0.0', '198.18.0.0', '224.0.0.0']) {
			expect(blockedAddressReason(address), address).not.toBeNull()
		}
	})

	test('private-only names are refused by spelling', () => {
		for (const host of ['router', 'postgres', 'printer.local', 'metadata.google.internal', 'nas.home.arpa', 'box.localdomain', 'service.local.']) {
			expect(blockedHostnameReason(host), host).not.toBeNull()
		}
		expect(blockedHostnameReason('example.com')).toBeNull()
		expect(blockedHostnameReason('example.com.')).toBeNull()
	})

	test('only http and https are allowed', () => {
		for (const url of ['file:///etc/passwd', 'ftp://example.com/', 'gopher://example.com/', 'data:text/html,hi', 'javascript:alert(1)', 'chrome://settings']) {
			const result = validateEgressUrl(url)
			expect(result.ok, url).toBe(false)
		}
	})

	test('anything that is not an address is refused, not waved through', () => {
		expect(blockedAddressReason('not-an-ip')).not.toBeNull()
		expect(blockedAddressReason('')).not.toBeNull()
		expect(blockedAddressReason('1.2.3')).not.toBeNull()
		expect(blockedAddressReason('1:2:3')).not.toBeNull()
	})

	test('IPv6 parsing handles compression, embedded IPv4 and zone ids', () => {
		expect(parseIPv6('::')).toEqual(Array(16).fill(0))
		expect(parseIPv6('[::1]')).toEqual([...Array(15).fill(0), 1])
		expect(parseIPv6('::ffff:1.2.3.4')?.slice(10)).toEqual([0xff, 0xff, 1, 2, 3, 4])
		expect(parseIPv6('fe80::1%eth0')?.slice(0, 2)).toEqual([0xfe, 0x80])
		expect(parseIPv6('1::2::3')).toBeNull()
		expect(parseIPv6('12345::')).toBeNull()
		expect(parseIPv6('1:2:3:4:5:6:7:8:9')).toBeNull()
		// DNS can hand back a scoped link-local address; it must still be refused.
		expect(blockedAddressReason('fe80::1%eth0')).not.toBeNull()
	})
})

// ── Lookup ───────────────────────────────────────────────────────────────────────

function lookupOnce(lookup: LookupFunction, host: string, all: boolean) {
	return new Promise<{ err: NodeJS.ErrnoException | null; address: unknown; family?: number }>((resolve) => {
		lookup(host, { all }, (err, address, family) => resolve({ err, address, family }))
	})
}

test.describe('egress guard — DNS', () => {
	test('a name that resolves to a private address is refused', async () => {
		const lookup = createGuardedLookup(fakeResolver(DNS_TABLE).resolve)
		for (const host of ['intranet.test', 'mapped.test']) {
			const { err } = await lookupOnce(lookup, host, true)
			expect(err, host).toBeInstanceOf(EgressBlockedError)
		}
	})

	test('one private answer among public ones taints the whole name', async () => {
		const lookup = createGuardedLookup(fakeResolver(DNS_TABLE).resolve)
		const { err } = await lookupOnce(lookup, 'rebind.test', true)
		expect(err).toBeInstanceOf(EgressBlockedError)
		expect(err?.message).toContain('127.0.0.1')
	})

	test('a public name resolves normally, in both callback shapes', async () => {
		const lookup = createGuardedLookup(fakeResolver(DNS_TABLE).resolve)
		const all = await lookupOnce(lookup, 'public.test', true)
		expect(all.err).toBeNull()
		expect(all.address).toEqual(DNS_TABLE['public.test'])
		const single = await lookupOnce(lookup, 'public.test', false)
		expect(single.err).toBeNull()
		expect(single.address).toBe('93.184.216.34')
		expect(single.family).toBe(4)
	})

	test('a name that is private by spelling never reaches the resolver', async () => {
		const dns = fakeResolver(DNS_TABLE)
		const lookup = createGuardedLookup(dns.resolve)
		for (const host of ['localhost', 'localhost.', 'db.internal']) {
			const { err } = await lookupOnce(lookup, host, true)
			expect(err, host).toBeInstanceOf(EgressBlockedError)
		}
		expect(dns.asked).toEqual([])
	})

	test('assertPublicUrl checks the DNS answer, not just the spelling', async () => {
		const lookup = createGuardedLookup(fakeResolver(DNS_TABLE).resolve)
		await expect(assertPublicUrl('https://intranet.test/admin', lookup)).rejects.toBeInstanceOf(EgressBlockedError)
		await expect(assertPublicUrl('https://public.test/page', lookup)).resolves.toBeInstanceOf(URL)
		await expect(assertPublicUrl('file:///etc/passwd', lookup)).rejects.toThrow(/unsupported protocol/)
	})
})

// ── Fixture server ───────────────────────────────────────────────────────────────

let fixture: Fixture
let port: number
const fx = (path: string) => fixture.url(path)

test.beforeAll(async () => {
	fixture = await startFixture()
	port = fixture.port
})

test.afterAll(async () => {
	await fixture.close()
})

test.beforeEach(() => {
	fixture.reset()
})

// ── Guarded GET ──────────────────────────────────────────────────────────────────

const LIMITS = { maxBytes: 1000, timeoutMs: 5000 }

test.describe('egress guard — guarded GET', () => {
	test('reaches an allowed host', async () => {
		const res = await guardedGet(fx('/ok'), { ...LIMITS, lookup: fixtureLookup })
		expect(res.status).toBe(200)
		expect(res.body.toString()).toBe('hello')
	})

	test('without the test lookup, loopback is refused before any request is sent', async () => {
		for (const url of [
			`http://127.0.0.1:${port}/secret`,
			`http://localhost:${port}/secret`,
			`http://localhost.:${port}/secret`,
			`http://[::ffff:127.0.0.1]:${port}/secret`,
		]) {
			await expect(guardedGet(url, LIMITS), url).rejects.toBeInstanceOf(EgressBlockedError)
		}
		expect(fixture.hits('/secret')).toBe(0)
	})

	test('a redirect to a private address is refused at the hop', async () => {
		for (const path of ['/redirect-literal', '/redirect-mapped', '/redirect-metadata']) {
			const err = await guardedGet(fx(path), { ...LIMITS, lookup: fixtureLookup }).catch((e) => e)
			expect(err, path).toBeInstanceOf(EgressBlockedError)
			expect(String(err.message), path).toContain('redirect')
		}
		expect(fixture.hits('/secret')).toBe(0)
	})

	test('a redirect to a name that resolves privately is refused at connect time', async () => {
		const err = await guardedGet(fx('/redirect-intranet'), { ...LIMITS, lookup: fixtureLookup }).catch((e) => e)
		expect(err).toBeInstanceOf(EgressBlockedError)
		expect(String(err.message)).toContain('10.1.2.3')
		expect(fixture.hits('/secret')).toBe(0)
	})

	test('a relative redirect to an allowed host is followed', async () => {
		const res = await guardedGet(fx('/redirect-relative'), { ...LIMITS, lookup: fixtureLookup })
		expect(res.body.toString()).toBe('hello')
		expect(res.url.pathname).toBe('/ok')
	})

	test('a redirect to another scheme is refused', async () => {
		await expect(guardedGet(fx('/redirect-file'), { ...LIMITS, lookup: fixtureLookup })).rejects.toThrow(/unsupported protocol/)
	})

	test('redirect loops stop', async () => {
		await expect(guardedGet(fx('/loop'), { ...LIMITS, lookup: fixtureLookup })).rejects.toThrow(/too many redirects/)
	})

	test('a declared length over the cap is refused before reading', async () => {
		await expect(guardedGet(fx('/big-declared'), { ...LIMITS, lookup: fixtureLookup })).rejects.toBeInstanceOf(EgressTooLargeError)
	})

	test('an undeclared body is cut off once it passes the cap', async () => {
		await expect(guardedGet(fx('/big-streamed'), { ...LIMITS, lookup: fixtureLookup })).rejects.toBeInstanceOf(EgressTooLargeError)
	})

	test('compressed bodies are decoded, and the cap applies after decoding', async () => {
		const res = await guardedGet(fx('/gzip'), { ...LIMITS, lookup: fixtureLookup })
		expect(res.body.toString()).toBe('compressed hello')
		await expect(guardedGet(fx('/gzip-bomb'), { ...LIMITS, lookup: fixtureLookup })).rejects.toBeInstanceOf(EgressTooLargeError)
	})

	test('a body that never finishes hits the deadline', async () => {
		const started = Date.now()
		await expect(guardedGet(fx('/slow'), { maxBytes: 1000, timeoutMs: 300, lookup: fixtureLookup })).rejects.toThrow(/timed out/)
		expect(Date.now() - started).toBeLessThan(3000)
	})

	test('guardedDownload streams to disk, and writes nothing for an error status', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'egress-spec-'))
		try {
			const ok = await guardedDownload(fx('/ok'), join(dir, 'ok.bin'), { ...LIMITS, lookup: fixtureLookup })
			expect(ok.bytes).toBe(5)
			expect(await readFile(join(dir, 'ok.bin'), 'utf8')).toBe('hello')

			const missing = await guardedDownload(fx('/not-found'), join(dir, 'missing.bin'), { ...LIMITS, lookup: fixtureLookup })
			expect(missing.status).toBe(404)
			expect(await stat(join(dir, 'missing.bin')).catch(() => null)).toBeNull()

			await expect(
				guardedDownload(fx('/big-streamed'), join(dir, 'big.bin'), { ...LIMITS, lookup: fixtureLookup }),
			).rejects.toBeInstanceOf(EgressTooLargeError)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})

// ── Proxy ────────────────────────────────────────────────────────────────────────

function proxiedGet(proxy: EgressProxy, target: string) {
	const { port: proxyPort } = new URL(proxy.url)
	return new Promise<{ status: number; refusal: string | undefined; body: string }>((resolve, reject) => {
		const req = http.request(
			{ host: '127.0.0.1', port: Number(proxyPort), method: 'GET', path: target, agent: false },
			(res) => {
				let body = ''
				res.on('data', (chunk) => (body += chunk))
				res.on('end', () =>
					resolve({ status: res.statusCode ?? 0, refusal: res.headers[EGRESS_REFUSAL_HEADER] as string | undefined, body }),
				)
			},
		)
		req.on('error', reject)
		req.end()
	})
}

function proxiedConnect(proxy: EgressProxy, authority: string) {
	const { port: proxyPort } = new URL(proxy.url)
	return new Promise<{ status: number; socket: net.Socket | null }>((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port: Number(proxyPort), method: 'CONNECT', path: authority, agent: false })
		req.on('connect', (res, socket) => {
			if (res.statusCode !== 200) socket.destroy()
			resolve({ status: res.statusCode ?? 0, socket: res.statusCode === 200 ? socket : null })
		})
		req.on('error', reject)
		req.end()
	})
}

test.describe('egress guard — browser proxy', () => {
	let proxy: EgressProxy

	test.beforeAll(async () => {
		proxy = await createEgressProxy({ lookup: fixtureLookup })
	})

	test.afterAll(async () => {
		await proxy.close()
	})

	test('plain HTTP to an allowed host is forwarded', async () => {
		const res = await proxiedGet(proxy, fx('/ok'))
		expect(res.status).toBe(200)
		expect(res.body).toBe('hello')
		expect(res.refusal).toBeUndefined()
	})

	test('plain HTTP to a private address is refused with the refusal header', async () => {
		for (const target of [
			`http://127.0.0.1:${port}/secret`,
			`http://[::ffff:127.0.0.1]:${port}/secret`,
			'http://169.254.169.254/latest/meta-data/',
			`http://intranet.test:${port}/secret`,
		]) {
			const res = await proxiedGet(proxy, target)
			expect(res.status, target).toBe(403)
			expect(res.refusal, target).toBeTruthy()
		}
		expect(fixture.hits('/secret')).toBe(0)
	})

	test('redirects pass through to the browser, which asks the proxy again for the next hop', async () => {
		const res = await proxiedGet(proxy, fx('/redirect-literal'))
		expect(res.status).toBe(302)
		expect(fixture.hits('/secret')).toBe(0)
	})

	test('requests that are not absolute http:// URLs are refused', async () => {
		expect((await proxiedGet(proxy, '/ok')).status).toBe(400)
	})

	test('CONNECT to a private target is refused', async () => {
		for (const authority of [`127.0.0.1:${port}`, `[::1]:${port}`, 'localhost:443', 'intranet.test:443', '169.254.169.254:80', `2130706433:${port}`]) {
			const res = await proxiedConnect(proxy, authority)
			expect(res.status, authority).toBe(403)
		}
		expect(fixture.hits('/secret')).toBe(0)
	})

	test('CONNECT to an allowed host opens a working tunnel', async () => {
		const res = await proxiedConnect(proxy, `${FIXTURE_HOST}:${port}`)
		expect(res.status).toBe(200)
		const socket = res.socket!
		socket.write(`GET /ok HTTP/1.1\r\nHost: ${FIXTURE_HOST}\r\nConnection: close\r\n\r\n`)
		let reply = ''
		socket.on('data', (chunk) => (reply += chunk))
		await once(socket, 'end')
		expect(reply).toContain('200 OK')
		expect(reply).toContain('hello')
	})
})

