import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '$env/dynamic/private'
import * as authSchema from '$lib/auth/auth.schema'
import * as chatSchema from '$lib/chat/chat.schema'
import * as memorySchema from '$lib/memory/memory.schema'
import * as agentsSchema from '$lib/agents/agents.schema'
import * as notificationsSchema from '$lib/notifications/notifications.schema'
import * as settingsSchema from '$lib/settings/settings.schema'
import * as activitySchema from '$lib/activity/activity.schema'
import * as artifactsSchema from '$lib/artifacts/artifacts.schema'
import * as llmUsageSchema from '$lib/cost/usage.schema'
import * as skillsSchema from '$lib/skills/skills.schema'

if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set')

const client = postgres(env.DATABASE_URL)

const schema = {
	...authSchema,
	...chatSchema,
	...memorySchema,
	...agentsSchema,
	...notificationsSchema,
	...settingsSchema,
	...activitySchema,
	...artifactsSchema,
	...llmUsageSchema,
	...skillsSchema,
}

export const db = drizzle(client, { schema })
