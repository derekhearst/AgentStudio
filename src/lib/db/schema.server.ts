/**
 * Aggregate Drizzle schema. Imported by `db.server.ts` (the runtime client) and
 * `db/bootstrap.server.ts` (the seeders, which need a fully-typed handle to feed
 * back into domain seed functions).
 *
 * Splitting this out keeps the two consumers from going through a circular
 * import — the bootstrap module would otherwise need `db.server.ts`'s
 * `createDatabase`, which would in turn want bootstrap to start the pipeline.
 */

import * as authSchema from '$lib/auth/auth.schema'
import * as sessionsSchema from '$lib/sessions/sessions.schema'
import * as agentsSchema from '$lib/agents/agents.schema'
import * as notificationsSchema from '$lib/notifications/notifications.schema'
import * as settingsSchema from '$lib/settings/settings.schema'
import * as activitySchema from '$lib/activity/activity.schema'
import * as llmUsageSchema from '$lib/costs/usage.schema'
import * as skillsSchema from '$lib/skills/skills.schema'
import * as automationSchema from '$lib/automations/automation.schema'
import * as runsSchema from '$lib/runs/runs.schema'
import * as memorySchema from '$lib/memory/memory.schema'
import * as chatWorkbenchSchema from '$lib/chat/chat.workbench.schema'
import * as contextSchema from '$lib/context/context.schema'
import * as governanceSchema from '$lib/governance/governance.schema'
import * as hooksSchema from '$lib/hooks/hooks.schema'
import * as evaluationsSchema from '$lib/evaluations/evaluations.schema'
import * as projectsSchema from '$lib/projects/projects.schema'
import * as jobsSchema from '$lib/jobs/jobs.schema'
import * as researchSchema from '$lib/research/research.schema'
import * as imagesSchema from '$lib/images/images.schema'
import * as observabilitySchema from '$lib/observability/observability.schema'
import * as sourceControlSchema from '$lib/source-control/source-control.schema'

export const schema = {
	...authSchema,
	...sessionsSchema,
	...agentsSchema,
	...notificationsSchema,
	...settingsSchema,
	...activitySchema,
	...llmUsageSchema,
	...skillsSchema,
	...memorySchema,
	...automationSchema,
	...runsSchema,
	...chatWorkbenchSchema,
	...contextSchema,
	...governanceSchema,
	...hooksSchema,
	...evaluationsSchema,
	...projectsSchema,
	...jobsSchema,
	...researchSchema,
	...imagesSchema,
	...observabilitySchema,
	...sourceControlSchema,
}

export type AppSchema = typeof schema
