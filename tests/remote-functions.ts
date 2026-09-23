import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

/**
 * Every remote function the app exports, found by reading the source rather than listed by
 * hand — a hand-kept list is exactly what goes stale the day someone adds a file, and the
 * point of the auth specs is that a new remote function is covered without anyone
 * remembering to cover it.
 */

export type RemoteFunctionKind = 'query' | 'command' | 'form' | 'prerender'

export type RemoteFunctionExport = {
	/** Repo-relative, forward slashes — the string SvelteKit hashes. */
	file: string
	name: string
	kind: RemoteFunctionKind
	/** `<hash>/<name>`: the path segment after `/_app/remote/`. */
	id: string
	/** The handler passed to `query(...)` / `command(...)`; null for an alias export. */
	handler: ts.ArrowFunction | ts.FunctionExpression | null
	/** `export const getStatus = getSandboxStatus` names the export it re-exports. */
	aliasOf: string | null
}

const ROOT = process.cwd()
const REMOTE_KINDS = new Set<string>(['query', 'command', 'form', 'prerender'])

/**
 * SvelteKit's `hash()` (src/utils/hash.js), which names a remote file by its repo-relative
 * path. Copied rather than deep-imported from node_modules; if SvelteKit ever changes it,
 * the "reachable with a session" checks in auth.remote-gate.spec.ts fail with 404s, so a
 * drift cannot turn into a quietly vacuous suite. (In dev a 404 can also mean the file has
 * not been compiled yet — those checks open the page that imports it first.)
 */
export function sveltekitHash(value: string): string {
	let hash = 5381
	let i = value.length
	while (i) hash = (hash * 33) ^ value.charCodeAt(--i)
	return (hash >>> 0).toString(36)
}

function findRemoteFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name)
		if (entry.isDirectory()) findRemoteFiles(path, out)
		else if (/\.remote\.(ts|js)$/.test(entry.name)) out.push(path)
	}
	return out
}

export function listRemoteFunctions(): RemoteFunctionExport[] {
	const found: RemoteFunctionExport[] = []
	for (const path of findRemoteFiles(join(ROOT, 'src')).sort()) {
		const file = relative(ROOT, path).split('\\').join('/')
		const source = ts.createSourceFile(file, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
		const byName = new Map<string, RemoteFunctionExport>()
		const aliases: Array<{ name: string; target: string }> = []

		for (const statement of source.statements) {
			if (!ts.isVariableStatement(statement)) continue
			if (!statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue
			for (const declaration of statement.declarationList.declarations) {
				const name = declaration.name.getText(source)
				const init = declaration.initializer
				if (!init) continue
				if (ts.isIdentifier(init)) {
					aliases.push({ name, target: init.text })
					continue
				}
				if (!ts.isCallExpression(init)) continue
				// `query(...)`, and `query.batch(...)` → `query`.
				const kind = init.expression.getText(source).split('.')[0]
				if (!REMOTE_KINDS.has(kind)) continue
				const last = init.arguments[init.arguments.length - 1]
				const handler = last && (ts.isArrowFunction(last) || ts.isFunctionExpression(last)) ? last : null
				const entry: RemoteFunctionExport = {
					file,
					name,
					kind: kind as RemoteFunctionKind,
					id: `${sveltekitHash(file)}/${name}`,
					handler,
					aliasOf: null,
				}
				byName.set(name, entry)
				found.push(entry)
			}
		}

		for (const alias of aliases) {
			const target = byName.get(alias.target)
			if (!target) continue
			found.push({ ...target, name: alias.name, id: `${sveltekitHash(file)}/${alias.name}`, handler: null, aliasOf: alias.target })
		}
	}
	return found
}
