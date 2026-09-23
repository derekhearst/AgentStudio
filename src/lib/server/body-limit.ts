/**
 * The request-body ceiling the production server enforces, and how an upload route tells a
 * refused-for-size body apart from a malformed one.
 *
 * adapter-node refuses any body larger than `BODY_SIZE_LIMIT` before a route sees a byte of
 * it, and its default is 512K. The refusal is an error on the request stream, so all a route
 * observes is `request.formData()` rejecting. The project-knowledge upload caught that as
 * "Expected a multipart upload": every file over half a megabyte failed with a message about
 * the wrong thing, and the 20MB limit the code advertised could never be reached. Chat
 * attachments failed the same way. `vite dev` enforces no limit at all, which is why nobody
 * saw it outside a deployment.
 *
 * The production image now sets `BODY_SIZE_LIMIT` to `RECOMMENDED_BODY_SIZE_LIMIT` (see the
 * Dockerfile). It is one number for every route — adapter-node has no per-route setting — so
 * it is sized for the largest document upload (20MB, plus multipart framing) rather than the
 * 100MB video attachments, which would also raise the ceiling on the public login and webhook
 * routes. An operator who wants large video raises it; the routes then report the real limit.
 */

/** adapter-node's own default when `BODY_SIZE_LIMIT` is unset. */
export const ADAPTER_DEFAULT_BODY_SIZE_LIMIT = '512K'

/** What the production image sets: a 20MB upload plus its multipart framing, with headroom. */
export const RECOMMENDED_BODY_SIZE_LIMIT = '25M'

/**
 * Bytes for a `BODY_SIZE_LIMIT` value, read the way adapter-node reads it: a number with an
 * optional K, M or G suffix (powers of 1024), and `Infinity` for no limit. NaN when invalid,
 * which adapter-node refuses to start with.
 */
export function parseBodySizeLimit(value: string): number {
	const multiplier = ({ K: 1024, M: 1024 ** 2, G: 1024 ** 3 } as Record<string, number>)[value.slice(-1).toUpperCase()] ?? 1
	return Number(multiplier === 1 ? value : value.slice(0, -1)) * multiplier
}

/**
 * The limit this process runs under, read exactly as adapter-node reads it — including a set
 * but empty value, which it takes as 0 bytes. Dev enforces none, but reports the production
 * default.
 */
export function bodySizeLimitBytes(env: Record<string, string | undefined> = process.env): number {
	const raw = 'BODY_SIZE_LIMIT' in env ? (env.BODY_SIZE_LIMIT ?? '') : ADAPTER_DEFAULT_BODY_SIZE_LIMIT
	const parsed = parseBodySizeLimit(raw)
	// adapter-node refuses to start on an unreadable value, so this process cannot be
	// running under one; report the default rather than NaN.
	return Number.isNaN(parsed) ? parseBodySizeLimit(ADAPTER_DEFAULT_BODY_SIZE_LIMIT) : parsed
}

/** `25MB`, `512KB`, `3.5MB` — for messages an operator reads. */
export function formatByteSize(bytes: number): string {
	if (!Number.isFinite(bytes)) return 'no limit'
	if (bytes >= 1024 ** 2) return `${Number((bytes / 1024 ** 2).toFixed(1))}MB`
	if (bytes >= 1024) return `${Number((bytes / 1024).toFixed(1))}KB`
	return `${bytes} bytes`
}

/**
 * Whether a failed body read was the server refusing the size.
 *
 * Two signals, because the runtime decides how the refusal surfaces. adapter-node errors the
 * stream with a 413; `formData()` may reject with that error itself or wrap it as a `cause`,
 * so the chain is walked. And a declared `Content-Length` over the limit settles it whatever
 * the error looks like — every browser upload declares one.
 */
export function isBodyTooLarge(error: unknown, request?: Request, limitBytes = bodySizeLimitBytes()): boolean {
	let current: unknown = error
	for (let depth = 0; current && depth < 5; depth++) {
		if (typeof current === 'object' && (current as { status?: unknown }).status === 413) return true
		current = (current as { cause?: unknown }).cause
	}
	const declared = Number(request?.headers.get('content-length'))
	return Number.isFinite(declared) && declared > limitBytes
}

/** The 413 message for a body the server refused, naming the limit and the setting that moves it. */
export function bodyTooLargeMessage(limitBytes = bodySizeLimitBytes()): string {
	return `That upload is larger than this server accepts (${formatByteSize(limitBytes)}). The limit is BODY_SIZE_LIMIT in the server's environment.`
}
