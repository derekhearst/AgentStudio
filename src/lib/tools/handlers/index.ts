/**
 * Composite dispatch table — merges every per-domain handler map into one
 * `Record<ToolName, ToolHandler>` the executor in `tools.server.ts` looks up against.
 */

import type { ToolHandler } from '../handler-types'
import { agentAutomationHandlers } from './agents-automations.server'
import { filesystemHandlers } from './filesystem.server'
import { mediaHandlers } from './media.server'
import { metaHandlers } from './meta.server'
import { projectsHandlers } from './projects.server'
import { skillsHandlers } from './skills.server'
import { sourceControlHandlers } from './source-control.server'
import { webHandlers } from './web.server'

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
	...filesystemHandlers,
	...webHandlers,
	...projectsHandlers,
	...mediaHandlers,
	...sourceControlHandlers,
	...agentAutomationHandlers,
	...skillsHandlers,
	...metaHandlers,
}
