import { query } from '$app/server'
import { desc, eq, sql } from 'drizzle-orm'
import { db } from '$lib/server/db'
import { agentTasks, agents, conversations, memories, messages, notifications } from '$lib/server/db/schema'

async function getCount(tableName: string) {
	const [row] = await db.execute<{ count: string }>(sql.raw(`select count(*)::text as count from ${tableName}`))
	return Number(row?.count ?? 0)
}

export const getDashboardSummary = query(async () => {
	const [
		conversationCount,
		messageCount,
		agentCount,
		taskCount,
		memoryCount,
		notificationCount,
		tasksByStatus,
		recentConversations,
		recentTasks,
	] = await Promise.all([
		getCount('conversations'),
		getCount('messages'),
		getCount('agents'),
		getCount('agent_tasks'),
		getCount('memories'),
		getCount('notifications'),
		db
			.select({
				status: agentTasks.status,
				count: sql<number>`count(*)::int`,
			})
			.from(agentTasks)
			.groupBy(agentTasks.status),
		db
			.select({
				id: conversations.id,
				title: conversations.title,
				updatedAt: conversations.updatedAt,
				model: conversations.model,
				totalTokens: conversations.totalTokens,
			})
			.from(conversations)
			.orderBy(desc(conversations.updatedAt))
			.limit(5),
		db
			.select({
				id: agentTasks.id,
				title: agentTasks.title,
				status: agentTasks.status,
				priority: agentTasks.priority,
				createdAt: agentTasks.createdAt,
				agentName: agents.name,
			})
			.from(agentTasks)
			.leftJoin(agents, eq(agents.id, agentTasks.agentId))
			.orderBy(desc(agentTasks.createdAt))
			.limit(6),
	])

	return {
		metrics: {
			conversationCount,
			messageCount,
			agentCount,
			taskCount,
			memoryCount,
			notificationCount,
		},
		tasksByStatus,
		recentConversations,
		recentTasks,
	}
})
