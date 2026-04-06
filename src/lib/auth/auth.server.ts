import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { env } from '$env/dynamic/private'
import type { Cookies } from '@sveltejs/kit'

const SESSION_COOKIE = 'drokbot_session'
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30

function requireSecret() {
	if (!env.AUTH_PASSWORD) {
		throw new Error('AUTH_PASSWORD is not set')
	}
	return env.AUTH_PASSWORD
}

function safeCompare(a: string, b: string) {
	const left = Buffer.from(a)
	const right = Buffer.from(b)
	if (left.length !== right.length) {
		return false
	}
	return timingSafeEqual(left, right)
}

function sign(nonce: string, secret: string) {
	return createHmac('sha256', secret).update(nonce).digest('base64url')
}

export function isValidPassword(password: string) {
	const secret = requireSecret()
	return safeCompare(password, secret)
}

export function createSessionToken() {
	const secret = requireSecret()
	const nonce = randomBytes(32).toString('base64url')
	const signature = sign(nonce, secret)
	return `${nonce}.${signature}`
}

export function validateSessionToken(token: string | undefined) {
	if (!token) {
		return false
	}

	const [nonce, signature] = token.split('.')
	if (!nonce || !signature) {
		return false
	}

	const expected = sign(nonce, requireSecret())
	return safeCompare(signature, expected)
}

export function setSessionCookie(cookies: Cookies) {
	const token = createSessionToken()
	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		secure: true,
		sameSite: 'lax',
		maxAge: MAX_AGE_SECONDS,
	})
}

export function clearSessionCookie(cookies: Cookies) {
	cookies.delete(SESSION_COOKIE, {
		path: '/',
	})
}

export function isAuthenticated(cookies: Cookies) {
	const token = cookies.get(SESSION_COOKIE)
	return validateSessionToken(token)
}
