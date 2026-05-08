import { listActiveAgentRunsForUser } from '$lib/runs'
import { createSseMonitorHandler } from '$lib/runtime/monitor-factory.server'

export const GET = createSseMonitorHandler(listActiveAgentRunsForUser)
