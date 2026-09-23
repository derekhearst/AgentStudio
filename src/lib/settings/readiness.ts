/**
 * Settings > System: is this instance configured? — the rules, as a pure function.
 *
 * First run asks for the owner account and nothing else. The model credential, the sandbox
 * folder, the gateway and the integrations belong to whoever runs the server: the sandbox
 * is a container mount a form cannot move, the Claude credential is the Claude Code CLI's
 * own login on the server, and a web form that stored API keys would only be a second,
 * disagreeing copy of what the deployment already sets. So they stay environment settings,
 * and this checklist answers "is it set up?" read-only, naming the variable to set.
 *
 * Only presence is reported, never a value — the rows go to the browser.
 */

import { ENGINE_AUTH_ENV_NAMES, engineEnvAllows } from '../engine/engine-env'

export type ReadinessRow = {
	id: string
	label: string
	/** Required rows make the instance unusable when not ok; optional rows turn a feature off. */
	required: boolean
	ok: boolean
	/** Plain-English status, safe to show: never contains a configured value. */
	detail: string
	/** The environment variables that control this row (names only). */
	envVars: string[]
}

export type ReadinessFacts = {
	env: Record<string, string | undefined>
	migrations: { databaseReachable: boolean; migrationsInSync: boolean; bundled: number | null; applied: number | null }
	/** Where a Claude Code CLI login was found on disk, or null. */
	claudeCredentialFile: string | null
	sandbox: { root: string; writable: boolean }
	/** Whether the OS sandbox (bubblewrap) can confine shell commands here. */
	shellSandbox: boolean
}

function isSet(env: Record<string, string | undefined>, key: string) {
	return (env[key]?.trim() ?? '') !== ''
}

/**
 * Environment variables, any of which authenticates a Claude run without a CLI login on disk.
 *
 * Only the ones the Claude Code CLI actually receives. It is spawned with an allow-listed
 * environment (`$lib/engine/engine-env`) that drops the server's `ANTHROPIC_*` on purpose,
 * so an `ANTHROPIC_API_KEY` set on the server never reaches a Claude run and must not turn
 * this row green. Derived from that list so the two cannot disagree.
 */
export const CLAUDE_CREDENTIAL_ENV_VARS: readonly string[] = ENGINE_AUTH_ENV_NAMES.filter(engineEnvAllows)

export function buildReadinessRows(facts: ReadinessFacts): ReadinessRow[] {
	const { env, migrations } = facts
	const rows: ReadinessRow[] = []

	rows.push({
		id: 'database',
		label: 'Database',
		required: true,
		ok: migrations.databaseReachable && migrations.migrationsInSync,
		detail: !migrations.databaseReachable
			? 'Cannot reach the database.'
			: migrations.migrationsInSync
				? `Reachable; all ${migrations.applied} migrations applied.`
				: `Reachable, but ${migrations.applied ?? '?'} of ${migrations.bundled ?? '?'} migrations are applied — the running build and the database disagree.`,
		envVars: ['DATABASE_URL'],
	})

	const credentialVar = CLAUDE_CREDENTIAL_ENV_VARS.find((key) => isSet(env, key))
	rows.push({
		id: 'claude',
		label: 'Claude sign-in',
		required: true,
		ok: Boolean(credentialVar || facts.claudeCredentialFile),
		detail: credentialVar
			? `Found ${credentialVar} in the environment.`
			: facts.claudeCredentialFile
				? 'Found a Claude Code login on the server. It is checked for real when a chat runs.'
				: 'No Claude credential found. Chats with Claude models will fail to authenticate. Sign in with the Claude Code CLI (run "claude login") as the user the server runs as, or set CLAUDE_CODE_OAUTH_TOKEN (from "claude setup-token").',
		envVars: [...CLAUDE_CREDENTIAL_ENV_VARS, 'CLAUDE_CONFIG_DIR'],
	})

	rows.push({
		id: 'sandbox',
		label: 'Workspace folder',
		required: true,
		ok: facts.sandbox.writable,
		detail: facts.sandbox.writable
			? `${facts.sandbox.root} exists and is writable.`
			: `${facts.sandbox.root} is missing or not writable. Agents cannot read or write files.`,
		envVars: ['SANDBOX_WORKSPACE'],
	})

	rows.push({
		id: 'shell-sandbox',
		label: 'Shell sandbox',
		required: false,
		ok: facts.shellSandbox,
		detail: facts.shellSandbox
			? 'Shell commands run confined by bubblewrap.'
			: 'bubblewrap is not available here (it is Linux-only), so shell commands need your approval instead of running confined.',
		// Nothing to set: the Docker image installs bubblewrap.
		envVars: [],
	})

	const gateway = isSet(env, 'LLM_GATEWAY_URL') && isSet(env, 'LLM_GATEWAY_TOKEN')
	rows.push({
		id: 'gateway',
		label: 'Model gateway',
		required: false,
		ok: gateway,
		detail: gateway
			? 'Non-Claude models run through the configured gateway, billed per token.'
			: 'Not configured: only Claude models are offered, and they run on the subscription.',
		envVars: ['LLM_GATEWAY_URL', 'LLM_GATEWAY_TOKEN'],
	})

	const optional: Array<{ id: string; label: string; vars: string[]; on: string; off: string }> = [
		{
			id: 'openrouter',
			label: 'OpenRouter',
			vars: ['OPENROUTER_API_KEY'],
			on: 'Set. Memory search, skill matching, image, video and speech features can call it.',
			off: 'Not set: memory search, skill matching, image, video and speech features are unavailable.',
		},
		{
			id: 'search',
			label: 'Web search',
			vars: ['SEARXNG_URL'],
			on: 'SearXNG is configured.',
			off: 'Not configured: the web search tool is unavailable.',
		},
		{
			id: 'github',
			label: 'GitHub connection',
			vars: ['GITHUB_OAUTH_CLIENT_ID', 'GITHUB_OAUTH_CLIENT_SECRET', 'APP_ENCRYPTION_KEY'],
			on: 'Set. Connect an account at Source control.',
			off: 'Not configured: GitHub cannot be connected at Source control.',
		},
		{
			id: 'github-webhooks',
			label: 'GitHub webhooks',
			vars: ['GITHUB_WEBHOOK_SECRET'],
			on: 'Set. Pull request and check events are accepted at /api/webhooks/github.',
			off: 'Not set: /api/webhooks/github answers 503.',
		},
		{
			id: 'push',
			label: 'Push notifications',
			vars: ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'],
			on: 'Set. Devices can subscribe under App & Push.',
			off: 'Not set: devices cannot subscribe to push notifications.',
		},
		{
			id: 'cron',
			label: 'External scheduler',
			vars: ['CRON_SECRET'],
			on: 'Set. An external scheduler can call /api/cron with the bearer secret.',
			off: 'Not set: only the built-in scheduler (or a signed-in session) runs scheduled jobs.',
		},
	]
	for (const item of optional) {
		const ok = item.vars.every((key) => isSet(env, key))
		rows.push({ id: item.id, label: item.label, required: false, ok, detail: ok ? item.on : item.off, envVars: item.vars })
	}

	return rows
}
