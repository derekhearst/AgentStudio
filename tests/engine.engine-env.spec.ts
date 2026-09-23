/**
 * The environment the Claude Code CLI is spawned with (`src/lib/engine/engine-env.ts`).
 *
 * Pure — no database, no server.
 *
 * The CLI passes its environment to every `Bash` command, and the OS sandbox does not stop a
 * command reading its own environment. With the server's whole `process.env` inherited,
 * `env` in a sandboxed shell printed the database URL, the key that decrypts stored GitHub
 * tokens, the OAuth client secret and the gateway token — into a tool result sent to the
 * model provider and stored in the run's events.
 */

import { expect, test } from '@playwright/test'
import { buildEngineEnv, engineAuthEnvNames } from '../src/lib/engine/engine-env'

const SERVER_ENV: Record<string, string> = {
	// What the CLI needs.
	PATH: '/usr/bin',
	HOME: '/data',
	CLAUDE_CONFIG_DIR: '/data/.claude',
	LANG: 'C.UTF-8',
	LC_ALL: 'C.UTF-8',
	HTTPS_PROXY: 'http://proxy:3128',
	// Windows spells these its own way.
	Path: 'C:\\Windows',
	SystemRoot: 'C:\\Windows',
	USERPROFILE: 'C:\\Users\\op',
	// The app's secrets.
	DATABASE_URL: 'postgres://user:pw@db/app',
	APP_ENCRYPTION_KEY: 'k',
	AUTH_PASSWORD: 'p',
	GITHUB_OAUTH_CLIENT_SECRET: 's',
	VAPID_PRIVATE_KEY: 'v',
	OPENROUTER_API_KEY: 'o',
	SEARXNG_PASSWORD: 'x',
	LLM_GATEWAY_TOKEN: 'g',
	LLM_GATEWAY_URL: 'https://gw',
	// An inherited API key would move a subscription run onto per-token billing.
	ANTHROPIC_API_KEY: 'sk-ant',
	ANTHROPIC_BASE_URL: 'https://elsewhere',
	// A server started from inside a Claude Code session carries the host's identity.
	CLAUDE_CODE_SESSION_ID: 'host-session',
	CLAUDE_CODE_MESSAGING_TOKEN: 'host-token',
}

test('the app\'s secrets never reach the CLI', () => {
	const env = buildEngineEnv(SERVER_ENV)
	for (const name of [
		'DATABASE_URL',
		'APP_ENCRYPTION_KEY',
		'AUTH_PASSWORD',
		'GITHUB_OAUTH_CLIENT_SECRET',
		'VAPID_PRIVATE_KEY',
		'OPENROUTER_API_KEY',
		'SEARXNG_PASSWORD',
		'LLM_GATEWAY_TOKEN',
		'LLM_GATEWAY_URL',
		'ANTHROPIC_API_KEY',
		'ANTHROPIC_BASE_URL',
		'CLAUDE_CODE_SESSION_ID',
		'CLAUDE_CODE_MESSAGING_TOKEN',
	]) {
		expect(env[name], name).toBeUndefined()
	}
})

test('what the CLI needs to run and to find its subscription login survives', () => {
	const env = buildEngineEnv(SERVER_ENV)
	expect(env.PATH).toBe('/usr/bin')
	expect(env.HOME).toBe('/data')
	expect(env.CLAUDE_CONFIG_DIR).toBe('/data/.claude')
	expect(env.LANG).toBe('C.UTF-8')
	expect(env.LC_ALL).toBe('C.UTF-8')
	expect(env.HTTPS_PROXY).toBe('http://proxy:3128')
	// Matched case-insensitively, spelled as the host spelled it.
	expect(env.Path).toBe('C:\\Windows')
	expect(env.SystemRoot).toBe('C:\\Windows')
	expect(env.USERPROFILE).toBe('C:\\Users\\op')
	// The long-lived form of the same login.
	expect(buildEngineEnv({ CLAUDE_CODE_OAUTH_TOKEN: 't' }).CLAUDE_CODE_OAUTH_TOKEN).toBe('t')
})

test('a gateway run gets exactly its own ANTHROPIC_* on top', () => {
	const env = buildEngineEnv(SERVER_ENV, {
		ANTHROPIC_BASE_URL: 'https://gw',
		ANTHROPIC_AUTH_TOKEN: 'gw-token',
		ANTHROPIC_MODEL: 'glm-4',
	})
	expect(env.ANTHROPIC_BASE_URL).toBe('https://gw')
	expect(env.ANTHROPIC_AUTH_TOKEN).toBe('gw-token')
	expect(env.ANTHROPIC_MODEL).toBe('glm-4')
	expect(env.ANTHROPIC_API_KEY).toBeUndefined()
	expect(env.DATABASE_URL).toBeUndefined()
})

test('the CLI\'s own credentials are named so the sandbox can hide them from a shell', () => {
	expect(engineAuthEnvNames(buildEngineEnv(SERVER_ENV))).toEqual([])
	expect(
		engineAuthEnvNames(buildEngineEnv({ PATH: '/bin' }, { ANTHROPIC_AUTH_TOKEN: 'gw', ANTHROPIC_BASE_URL: 'x' })),
	).toEqual(['ANTHROPIC_AUTH_TOKEN'])
	expect(engineAuthEnvNames(buildEngineEnv({ CLAUDE_CODE_OAUTH_TOKEN: 't' }))).toEqual(['CLAUDE_CODE_OAUTH_TOKEN'])
})
