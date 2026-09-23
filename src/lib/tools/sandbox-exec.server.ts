/**
 * Whether bubblewrap can confine a child process on this host (#54).
 *
 * The engine's `Bash` runs inside the Agent SDK's OS sandbox, which is built on bubblewrap,
 * and `sandboxAvailable()` in `$lib/engine/options.server` decides from this probe whether
 * to turn that sandbox on. Settings > System reports the same answer.
 *
 * This module also used to build the bubblewrap argv for `run_code`'s script process. That
 * tool was retired (#69) and the planner went with it; the probe is what is left.
 */

import { spawnSync } from 'node:child_process'
import { logger } from '$lib/observability/logger'

let probed: boolean | null = null

/**
 * Whether bubblewrap can actually run here, probed once per process.
 *
 * Deliberately executes `bwrap --version` rather than checking the platform: the binary
 * can be present but unusable (no user namespaces, a restrictive seccomp profile), and a
 * sandbox that is assumed rather than verified is the failure mode this whole area exists
 * to avoid.
 */
export function bubblewrapAvailable(): boolean {
	if (probed !== null) return probed
	if (process.platform !== 'linux') {
		probed = false
		return probed
	}
	try {
		const result = spawnSync('bwrap', ['--version'], { stdio: 'ignore', timeout: 5000 })
		probed = result.status === 0
	} catch {
		probed = false
	}
	if (!probed) {
		logger.warn('[sandbox-exec] bubblewrap unavailable; child processes cannot be confined')
	}
	return probed
}
