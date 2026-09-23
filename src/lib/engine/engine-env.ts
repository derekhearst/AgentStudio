/**
 * The environment the Claude Code CLI is spawned with.
 *
 * ## Why this is an allow-list
 *
 * With `Options.env` omitted the SDK hands the CLI the web server's whole `process.env`,
 * and the gateway path used to spread it explicitly. The CLI passes its environment on to
 * every `Bash` command, and the OS sandbox confines what a command can *write*, not what it
 * can read out of its own environment. So `env` in a sandboxed shell printed
 * `DATABASE_URL`, `APP_ENCRYPTION_KEY` (which decrypts stored GitHub tokens), the OAuth
 * client secret, the VAPID private key and the gateway token — into a tool result that is
 * sent to the model provider and stored in the run's events.
 *
 * The retired in-house shell never had this problem: it built a minimal env of its own
 * (`run_code` still does). This is that rule applied to the CLI. An allow-list rather than
 * a deny-list, because the secrets this app grows next will not be added to a deny-list.
 *
 * What survives: what a process needs to run at all (the executable path, the home and temp
 * directories, locale, the Windows system variables), how to reach the network (proxies,
 * extra CA certificates), and the CLI's own login — `CLAUDE_CONFIG_DIR`, where it keeps it
 * (or `~/.claude` under `HOME`), and `CLAUDE_CODE_OAUTH_TOKEN`, the long-lived form of the
 * same subscription login. Not the rest of `CLAUDE_CODE_*`: when the server itself was started
 * from inside a Claude Code session, that family carries the host session's identity and
 * messaging token, which a child CLI must not inherit. `ANTHROPIC_*` from the server is
 * dropped on purpose too: a Claude run is meant to be on the subscription login, and an
 * inherited API key would silently move it onto per-token billing. A gateway run gets its
 * three `ANTHROPIC_*` variables explicitly.
 *
 * Pure, so the spec can check exactly which names cross.
 */

/** Exact names that cross, compared case-insensitively (Windows spells `PATH` as `Path`). */
export const ENGINE_ENV_NAMES: readonly string[] = [
	// Process basics.
	'PATH',
	'HOME',
	'USER',
	'LOGNAME',
	'SHELL',
	'TERM',
	'TZ',
	'LANG',
	'LANGUAGE',
	'TMPDIR',
	'TMP',
	'TEMP',
	// Windows. The CLI is a native executable there, and networking and crypto fail without
	// `SystemRoot`; the rest are what a Windows process expects to find.
	'USERPROFILE',
	'HOMEDRIVE',
	'HOMEPATH',
	'APPDATA',
	'LOCALAPPDATA',
	'PROGRAMDATA',
	'PROGRAMFILES',
	'PROGRAMFILES(X86)',
	'COMMONPROGRAMFILES',
	'SYSTEMROOT',
	'SYSTEMDRIVE',
	'WINDIR',
	'COMSPEC',
	'PATHEXT',
	'OS',
	'PROCESSOR_ARCHITECTURE',
	'NUMBER_OF_PROCESSORS',
	'USERNAME',
	'USERDOMAIN',
	'COMPUTERNAME',
	// Reaching the network from behind a proxy or a private CA.
	'HTTP_PROXY',
	'HTTPS_PROXY',
	'NO_PROXY',
	'ALL_PROXY',
	'NODE_EXTRA_CA_CERTS',
	'SSL_CERT_FILE',
	'SSL_CERT_DIR',
	// The CLI's own login: the directory it keeps it in, or the long-lived token form of it.
	'CLAUDE_CONFIG_DIR',
	'CLAUDE_CODE_OAUTH_TOKEN',
	// Where a Windows developer's Git Bash is, which the CLI's Bash tool needs there.
	'CLAUDE_CODE_GIT_BASH_PATH',
]

/** Prefixes that cross: locale and the XDG base directories. */
export const ENGINE_ENV_PREFIXES: readonly string[] = ['LC_', 'XDG_']

/**
 * Variables that authenticate the CLI itself. They have to reach the CLI, and must not reach
 * a sandboxed shell — `./options.server` lists whichever are present under the sandbox's
 * `credentials.envVars` with mode `deny`, which unsets them inside it.
 */
export const ENGINE_AUTH_ENV_NAMES: readonly string[] = [
	'CLAUDE_CODE_OAUTH_TOKEN',
	'ANTHROPIC_AUTH_TOKEN',
	'ANTHROPIC_API_KEY',
]

const NAME_SET = new Set(ENGINE_ENV_NAMES.map((name) => name.toUpperCase()))

/** True when a server variable may be passed to the CLI. */
export function engineEnvAllows(name: string): boolean {
	const upper = name.toUpperCase()
	return NAME_SET.has(upper) || ENGINE_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))
}

/**
 * Build the CLI's environment from the server's, keeping only what `engineEnvAllows`, then
 * layering `extra` on top (the gateway's `ANTHROPIC_*`). Undefined values are dropped, and
 * the original spelling of each name is kept.
 */
export function buildEngineEnv(
	source: Record<string, string | undefined>,
	extra: Record<string, string> = {},
): Record<string, string> {
	const out: Record<string, string> = {}
	for (const [name, value] of Object.entries(source)) {
		if (typeof value !== 'string') continue
		if (engineEnvAllows(name)) out[name] = value
	}
	return { ...out, ...extra }
}

/** The auth variables present in a built env — what the sandbox must hide from a shell. */
export function engineAuthEnvNames(env: Record<string, string>): string[] {
	const present = new Set(Object.keys(env).map((name) => name.toUpperCase()))
	return ENGINE_AUTH_ENV_NAMES.filter((name) => present.has(name))
}
