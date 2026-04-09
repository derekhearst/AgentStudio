import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { agents } from '$lib/agents/agents.schema'
import { conversations } from '$lib/chat/chat.schema'
import { memoryRooms, memoryWings } from '$lib/memory/palace.schema'
import { automations } from '$lib/automation/automation.schema'
import { memories } from '$lib/memory/memory.schema'
import { computeNextRunAt } from '$lib/automation/engine'

const DREAMING_AGENT_NAME = 'Dreaming Agent'
const SEEDED_USERS = new Map<string, number>()
const SEED_CACHE_TTL_MS = 5 * 60 * 1000

const DEFAULT_WINGS = [
	{ name: 'Personal', description: 'Stable identity, preferences, and personal context.' },
	{ name: 'AgentStudio', description: 'Product, workflow, and platform details.' },
] as const

const DEFAULT_ROOMS = [
	{ wing: 'Personal', name: 'Identity', description: 'Core profile and durable user context.' },
	{ wing: 'Personal', name: 'Preferences', description: 'Style, tooling, and communication preferences.' },
	{ wing: 'AgentStudio', name: 'Architecture', description: 'System architecture and key design choices.' },
	{ wing: 'AgentStudio', name: 'Workflow', description: 'Current plans, phases, and execution constraints.' },
] as const

export type AgentStatus = (typeof agents.$inferSelect)['status']

function normalizeRoomName(name: string) {
	return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

async function ensureDefaultPalace(userId: string) {
	const existingWings = await db.select().from(memoryWings).where(eq(memoryWings.userId, userId))
	const byName = new Map(existingWings.map((wing) => [wing.name.toLowerCase(), wing]))

	for (const wingDef of DEFAULT_WINGS) {
		if (!byName.has(wingDef.name.toLowerCase())) {
			const [created] = await db
				.insert(memoryWings)
				.values({
					userId,
					name: wingDef.name,
					description: wingDef.description,
					updatedAt: new Date(),
				})
				.returning()
			byName.set(wingDef.name.toLowerCase(), created)
		}
	}

	const wingIds = [...byName.values()].map((wing) => wing.id)
	const existingRooms = wingIds.length ? await db.select().from(memoryRooms).where(eq(memoryRooms.isCloset, false)) : []
	const roomKeys = new Set(existingRooms.map((room) => `${room.wingId}:${normalizeRoomName(room.name)}`))

	for (const roomDef of DEFAULT_ROOMS) {
		const wing = byName.get(roomDef.wing.toLowerCase())
		if (!wing) continue
		const key = `${wing.id}:${normalizeRoomName(roomDef.name)}`
		if (!roomKeys.has(key)) {
			const [room] = await db
				.insert(memoryRooms)
				.values({
					wingId: wing.id,
					name: roomDef.name,
					description: roomDef.description,
					updatedAt: new Date(),
				})
				.returning()

			roomKeys.add(key)

			const closetName = `${roomDef.name} Closet`
			await db.insert(memoryRooms).values({
				wingId: wing.id,
				name: closetName,
				description: `Summary closet for ${roomDef.name}`,
				isCloset: true,
				closetForRoomId: room.id,
				updatedAt: new Date(),
			})
		}
	}
}

async function classifyFlatMemories(userId: string) {
	const personalWing = await db
		.select()
		.from(memoryWings)
		.where(and(eq(memoryWings.userId, userId), eq(memoryWings.name, 'Personal')))
		.limit(1)
	const studioWing = await db
		.select()
		.from(memoryWings)
		.where(and(eq(memoryWings.userId, userId), eq(memoryWings.name, 'AgentStudio')))
		.limit(1)

	if (!personalWing[0] || !studioWing[0]) return 0

	const rooms = await db.select().from(memoryRooms)
	const roomByName = new Map(rooms.map((room) => [`${room.wingId}:${normalizeRoomName(room.name)}`, room]))

	const personalIdentity = roomByName.get(`${personalWing[0].id}:${normalizeRoomName('Identity')}`)
	const personalPreferences = roomByName.get(`${personalWing[0].id}:${normalizeRoomName('Preferences')}`)
	const studioArchitecture = roomByName.get(`${studioWing[0].id}:${normalizeRoomName('Architecture')}`)
	const studioWorkflow = roomByName.get(`${studioWing[0].id}:${normalizeRoomName('Workflow')}`)

	const unmapped = await db
		.select()
		.from(memories)
		.where(and(isNull(memories.wingId), isNull(memories.roomId)))
		.limit(200)

	let updated = 0
	for (const memory of unmapped) {
		const category = memory.category.toLowerCase()
		if (category.includes('preference') && personalPreferences) {
			await db
				.update(memories)
				.set({
					wingId: personalWing[0].id,
					roomId: personalPreferences.id,
					hallType: 'preferences',
					updatedAt: new Date(),
				})
				.where(eq(memories.id, memory.id))
			updated++
			continue
		}

		if ((category.includes('project') || category.includes('constraint')) && studioWorkflow) {
			await db
				.update(memories)
				.set({
					wingId: studioWing[0].id,
					roomId: studioWorkflow.id,
					hallType: 'events',
					updatedAt: new Date(),
				})
				.where(eq(memories.id, memory.id))
			updated++
			continue
		}

		if (category.includes('person') && personalIdentity) {
			await db
				.update(memories)
				.set({
					wingId: personalWing[0].id,
					roomId: personalIdentity.id,
					hallType: 'facts',
					updatedAt: new Date(),
				})
				.where(eq(memories.id, memory.id))
			updated++
			continue
		}

		if (studioArchitecture) {
			await db
				.update(memories)
				.set({
					wingId: studioWing[0].id,
					roomId: studioArchitecture.id,
					hallType: 'discoveries',
					updatedAt: new Date(),
				})
				.where(eq(memories.id, memory.id))
			updated++
		}
	}

	return updated
}

export async function ensureDreamingAgentForUser(userId: string) {
	const cachedAt = SEEDED_USERS.get(userId)
	if (cachedAt && Date.now() - cachedAt < SEED_CACHE_TTL_MS) {
		const [existingAgent] = await db.select().from(agents).where(eq(agents.name, DREAMING_AGENT_NAME)).limit(1)
		if (existingAgent) return existingAgent
	}

	const [existing] = await db.select().from(agents).where(eq(agents.name, DREAMING_AGENT_NAME)).limit(1)

	const dreamingAgent =
		existing ??
		(
			await db
				.insert(agents)
				.values({
					name: DREAMING_AGENT_NAME,
					role: 'Memory Palace caretaker and consolidation specialist',
					systemPrompt: [
						'You are the Dreaming Agent for AgentStudio.',
						'Your job is to maintain the Memory Palace: classify drawers, maintain closets, detect contradictions, and keep L1 concise.',
						'Prefer deterministic summarization and avoid losing durable user facts.',
					].join('\n'),
					model: 'openai/gpt-4o-mini',
					status: 'active',
					config: {
						allowedTools: [
							'palace_create_wing',
							'palace_create_room',
							'palace_place_drawer',
							'palace_update_closet',
							'palace_search',
							'palace_check_duplicate',
							'palace_decay',
							'palace_prune',
							'palace_detect_contradictions',
							'palace_regenerate_l1',
						],
					},
				})
				.returning()
		)[0]

	await ensureDefaultPalace(userId)
	await classifyFlatMemories(userId)

	const [existingAutomation] = await db
		.select()
		.from(automations)
		.where(and(eq(automations.userId, userId), eq(automations.description, 'Memory consolidation')))
		.limit(1)

	if (!existingAutomation) {
		await db.insert(automations).values({
			userId,
			agentId: dreamingAgent.id,
			description: 'Memory consolidation',
			cronExpression: '0 * * * *',
			prompt:
				'Consolidate recent memory drawers into concise closet summaries, detect contradictions, and refresh the always-on L1 narrative.',
			enabled: true,
			conversationMode: 'new_each_run',
			nextRunAt: computeNextRunAt('0 * * * *'),
			updatedAt: new Date(),
		})
	}

	SEEDED_USERS.set(userId, Date.now())

	return dreamingAgent
}

export async function listAgentsWithCounts() {
	const rows = await db.select().from(agents).orderBy(asc(agents.createdAt))
	return rows
}

export async function getAgentDetail(agentId: string) {
	const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1)
	if (!agent) return null

	const chats = await db
		.select()
		.from(conversations)
		.where(eq(conversations.agentId, agentId))
		.orderBy(desc(conversations.updatedAt))
		.limit(50)

	return { agent, conversations: chats }
}

export async function updateAgentRecord(
	agentId: string,
	patch: { name?: string; role?: string; systemPrompt?: string; model?: string },
) {
	const updates: Partial<typeof agents.$inferInsert> = {}
	if (patch.name !== undefined) updates.name = patch.name
	if (patch.role !== undefined) updates.role = patch.role
	if (patch.systemPrompt !== undefined) updates.systemPrompt = patch.systemPrompt
	if (patch.model !== undefined) updates.model = patch.model

	if (Object.keys(updates).length === 0) return null

	const [updated] = await db.update(agents).set(updates).where(eq(agents.id, agentId)).returning()
	return updated ?? null
}

export async function setAgentStatus(agentId: string, status: AgentStatus) {
	const [updated] = await db.update(agents).set({ status }).where(eq(agents.id, agentId)).returning()
	return updated ?? null
}
