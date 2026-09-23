import { readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { expect, test } from '@playwright/test'
import { getRequest } from '@sveltejs/kit/node'
// @ts-expect-error — adapter-node's runtime helpers ship untyped; this is the parser it runs.
import { parse_as_bytes } from '../node_modules/@sveltejs/adapter-node/files/utils.js'
import { cleanupPrefixedRecords, getActiveUserId, seedProject, uniquePrefix } from './helpers'
import {
	ADAPTER_DEFAULT_BODY_SIZE_LIMIT,
	RECOMMENDED_BODY_SIZE_LIMIT,
	bodySizeLimitBytes,
	bodyTooLargeMessage,
	isBodyTooLarge,
	parseBodySizeLimit,
} from '../src/lib/server/body-limit'
import { MAX_KNOWLEDGE_FILE_BYTES, knowledgeRoot, listKnowledgeFiles } from '../src/lib/projects/project-knowledge.server'

/**
 * #143 — uploads over 512KB failed as "Expected a multipart upload".
 *
 * The production server is adapter-node, which refuses any body larger than
 * `BODY_SIZE_LIMIT` and defaults it to 512K. Nothing set it, so a 3MB datasheet never
 * reached the knowledge route's own 20MB check: the refusal surfaced as `formData()`
 * rejecting, which the route reported as a malformed body. The Playwright server is
 * `vite dev`, which enforces no limit, so nothing here could see it.
 *
 * These drive SvelteKit's own node request adapter — the code adapter-node runs — over a
 * fake socket, so the refusal is the real one rather than a hand-made error.
 */

const KB = 1024
const MB = 1024 * 1024
const BOUNDARY = 'agentstudio-body-limit'

/** A request body as adapter-node receives it: a stream plus headers. */
function incoming(body: Buffer, opts: { declareLength: boolean }): IncomingMessage {
	const stream = new PassThrough()
	Object.assign(stream, {
		method: 'POST',
		url: '/upload',
		httpVersionMajor: 1,
		headers: {
			host: 'localhost',
			'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
			...(opts.declareLength ? { 'content-length': String(body.length) } : { 'transfer-encoding': 'chunked' }),
		},
	})
	// Chunked, so a streamed refusal happens part-way through rather than on the first write.
	for (let offset = 0; offset < body.length; offset += 64 * KB) stream.write(body.subarray(offset, offset + 64 * KB))
	stream.end()
	return stream as unknown as IncomingMessage
}

function multipart(filename: string, bytes: number): Buffer {
	return Buffer.concat([
		Buffer.from(
			`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`,
		),
		Buffer.alloc(bytes, 0x61),
		Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
	])
}

/** What `request.formData()` does with the body, as the route sees it. */
async function formDataError(request: Request): Promise<unknown> {
	try {
		await request.formData()
		return null
	} catch (error) {
		return error
	}
}

test.describe('server/body-limit — reading BODY_SIZE_LIMIT', () => {
	test('parses a value exactly as adapter-node does', () => {
		for (const value of ['512K', '25M', '1G', '1048576', 'Infinity', '25m', '', 'abc', '10X']) {
			const ours = parseBodySizeLimit(value)
			const theirs = parse_as_bytes(value)
			if (Number.isNaN(theirs)) expect(Number.isNaN(ours), value).toBe(true)
			else expect(ours, value).toBe(theirs)
		}
	})

	test('unset means the adapter default; set-but-empty means 0, as it does to the server', () => {
		expect(bodySizeLimitBytes({})).toBe(parseBodySizeLimit(ADAPTER_DEFAULT_BODY_SIZE_LIMIT))
		expect(bodySizeLimitBytes({ BODY_SIZE_LIMIT: '25M' })).toBe(25 * MB)
		expect(bodySizeLimitBytes({ BODY_SIZE_LIMIT: '' })).toBe(0)
	})

	test('the production image sets a limit that fits the largest upload the routes accept', () => {
		const dockerfile = readFileSync(resolve('Dockerfile'), 'utf8')
		const set = /^ENV BODY_SIZE_LIMIT=(\S+)$/m.exec(dockerfile)
		expect(set, 'the Dockerfile sets BODY_SIZE_LIMIT').not.toBeNull()
		expect(set![1]).toBe(RECOMMENDED_BODY_SIZE_LIMIT)
		// A 20MB knowledge file (and a 20MB chat attachment) plus its multipart framing.
		expect(parseBodySizeLimit(set![1])).toBeGreaterThan(MAX_KNOWLEDGE_FILE_BYTES + 64 * KB)
	})
})

test.describe('server/body-limit — telling a refused size from a broken body', () => {
	test('a declared length over the limit is refused, and recognised as that', async () => {
		const request = await getRequest({
			request: incoming(multipart('datasheet.pdf', 3 * MB), { declareLength: true }),
			base: 'http://localhost',
			bodySizeLimit: 512 * KB,
		})
		const error = await formDataError(request)
		expect(error, 'adapter-node refuses the body').not.toBeNull()
		expect(isBodyTooLarge(error, request, 512 * KB)).toBe(true)
	})

	test('a streamed body that outgrows the limit is recognised from the error alone', async () => {
		// No Content-Length to fall back on, so this is the error chain doing the work.
		const request = await getRequest({
			request: incoming(multipart('datasheet.pdf', 3 * MB), { declareLength: false }),
			base: 'http://localhost',
			bodySizeLimit: 512 * KB,
		})
		const error = await formDataError(request)
		expect(error).not.toBeNull()
		expect(isBodyTooLarge(error, request, 512 * KB)).toBe(true)
	})

	test('the same upload under the production limit parses', async () => {
		const request = await getRequest({
			request: incoming(multipart('datasheet.pdf', 3 * MB), { declareLength: true }),
			base: 'http://localhost',
			bodySizeLimit: parseBodySizeLimit(RECOMMENDED_BODY_SIZE_LIMIT),
		})
		const form = await request.formData()
		expect((form.get('file') as File).size).toBe(3 * MB)
	})

	test('a malformed body within the limit is still a malformed body', async () => {
		const request = new Request('http://localhost/upload', {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
			body: 'not multipart at all',
		})
		const error = await formDataError(request)
		expect(error).not.toBeNull()
		expect(isBodyTooLarge(error, request, 512 * KB)).toBe(false)
	})

	test('the message names the limit and the setting that moves it', () => {
		expect(bodyTooLargeMessage(512 * KB)).toContain('512KB')
		expect(bodyTooLargeMessage(25 * MB)).toContain('25MB')
		expect(bodyTooLargeMessage(25 * MB)).toContain('BODY_SIZE_LIMIT')
	})
})

test.describe('server/body-limit — the knowledge route', () => {
	/*
	 * The route itself, handed the request adapter-node would hand it. Before, this answered
	 * 400 "Expected a multipart upload" and the operator had no way to tell why.
	 */
	test('an upload the server refused for size is a 413 that says so, and nothing is saved', async () => {
		const prefix = uniquePrefix('body-limit-knowledge')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const { POST } = await import('../src/routes/projects/[id]/knowledge/+server')
		let projectId = ''
		try {
			projectId = (await seedProject(prefix)).id
			const request = await getRequest({
				request: incoming(multipart('datasheet.pdf', 3 * MB), { declareLength: true }),
				base: 'http://localhost',
				bodySizeLimit: 512 * KB,
			})
			const response = await POST({
				request,
				params: { id: projectId },
				locals: { user: { id: userId } },
			} as unknown as Parameters<typeof POST>[0])
			expect(response.status).toBe(413)
			expect((await response.json()).error).toContain('BODY_SIZE_LIMIT')
			expect(await listKnowledgeFiles(userId, projectId)).toEqual([])
		} finally {
			if (projectId) await rm(knowledgeRoot(userId, projectId), { recursive: true, force: true }).catch(() => {})
			await cleanupPrefixedRecords(prefix)
		}
	})
})
