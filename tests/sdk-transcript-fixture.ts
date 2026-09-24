import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A synthetic Claude Code session on disk: a transcript and the file-history backups its
 * checkpoints point at. Enough for the bundled CLI to resume it and answer `rewindFiles`
 * with no model call and no credentials — which is exactly what a rewind control session
 * does (`src/lib/engine/rewind.server.ts`), so the real CLI can be tested against it.
 *
 * The layout is the CLI's own, read from the bundled `claude` (SDK 0.3.278):
 *
 *   <configDir>/projects/<cwd with every non-alphanumeric as '-'>/<sessionId>.jsonl
 *   <configDir>/file-history/<sessionId>/<16 hex>@v<n>
 *
 * A `file-history-snapshot` entry is keyed by the user message's uuid; a tracked path maps
 * to the backup of that file as it was at that message, or `null` when it did not exist
 * yet (a rewind then deletes it). This is internal to the CLI. If a CLI upgrade changes it,
 * the specs that use this fixture fail — which is the point: they are the canary for the
 * rewind path still working against the CLI we ship.
 */

export const BACKUP_NAME = /^[0-9a-f]{16}@v\d+$/

export function syntheticTranscript(input: { sessionId: string; cwd: string }) {
	const common = {
		sessionId: input.sessionId,
		cwd: input.cwd,
		isSidechain: false,
		userType: 'external',
		version: '2.0.0',
	}
	let clock = Date.parse('2026-09-01T12:00:00Z')
	const stamp = () => new Date((clock += 1000)).toISOString()

	return {
		user(uuid: string, parentUuid: string | null, content = 'change the files') {
			return { ...common, type: 'user', uuid, parentUuid, timestamp: stamp(), message: { role: 'user', content } }
		},
		assistant(uuid: string, parentUuid: string, text = 'done') {
			return {
				...common,
				type: 'assistant',
				uuid,
				parentUuid,
				timestamp: stamp(),
				message: {
					id: `msg_${uuid.slice(0, 8)}`,
					type: 'message',
					role: 'assistant',
					model: 'claude-sonnet-4-5',
					content: [{ type: 'text', text }],
					stop_reason: 'end_turn',
					stop_sequence: null,
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			}
		},
		/** Workspace-relative path → backup file name, or null for "did not exist at this message". */
		snapshot(messageId: string, tracked: Record<string, string | null>) {
			const at = stamp()
			const trackedFileBackups = Object.fromEntries(
				Object.entries(tracked).map(([path, backupFileName]) => [path, { backupFileName, version: 1, backupTime: at }]),
			)
			return {
				type: 'file-history-snapshot',
				messageId,
				isSnapshotUpdate: false,
				snapshot: { messageId, timestamp: at, trackedFileBackups },
			}
		},
	}
}

/** Write the transcript and the backups where the CLI looks for them. */
export function writeSyntheticSession(input: {
	configDir: string
	cwd: string
	sessionId: string
	entries: unknown[]
	/** Backup file name → the file's content at the checkpoint. */
	backups: Record<string, string>
}): void {
	const historyDir = join(input.configDir, 'file-history', input.sessionId)
	mkdirSync(historyDir, { recursive: true })
	for (const [name, content] of Object.entries(input.backups)) {
		if (!BACKUP_NAME.test(name)) throw new Error(`Not a backup name the CLI accepts: ${name}`)
		writeFileSync(join(historyDir, name), content)
	}
	const projectDir = join(input.configDir, 'projects', input.cwd.replace(/[^a-zA-Z0-9]/g, '-'))
	mkdirSync(projectDir, { recursive: true })
	writeFileSync(
		join(projectDir, `${input.sessionId}.jsonl`),
		`${input.entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
	)
}
