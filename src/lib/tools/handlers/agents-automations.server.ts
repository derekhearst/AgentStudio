/**
 * Agent + Automation tool handlers — small enough to share a file. Both groups CRUD
 * domain rows for the orchestrator (the chat-flavor agents) so the model can manage
 * its own configuration without going through the UI.
 */

import { toolSchemas } from '../tool-schemas'
import { setAgentStatus, updateAgentRecord } from '$lib/agents/agents.server'
import {
	createAutomationRecord,
	deleteAutomationRecord,
	listAutomationsForUser,
	updateAutomationRecord,
} from '$lib/automations/automation.server'
import type { ToolHandler } from '../handler-types'

export const agentAutomationHandlers: Record<string, ToolHandler> = {
	update_agent: async (call, { startedAt }) => {
		const input = toolSchemas.update_agent.parse(call.arguments)
		const updated = await updateAgentRecord(input.agentId, {
			name: input.name,
			role: input.role,
			systemPrompt: input.systemPrompt,
			model: input.model,
		})
		if (!updated) {
			return {
				success: false,
				tool: call.name,
				error: 'Agent not found or no fields provided',
				executionMs: Date.now() - startedAt,
			}
		}
		return {
			success: true,
			tool: call.name,
			input,
			result: { id: updated.id, name: updated.name, status: updated.status },
			executionMs: Date.now() - startedAt,
		}
	},

	pause_agent: async (call, { startedAt }) => {
		const input = toolSchemas.pause_agent.parse(call.arguments)
		const updated = await setAgentStatus(input.agentId, 'paused')
		if (!updated) {
			return {
				success: false,
				tool: call.name,
				error: 'Agent not found',
				executionMs: Date.now() - startedAt,
			}
		}
		return {
			success: true,
			tool: call.name,
			input,
			result: { id: updated.id, status: updated.status },
			executionMs: Date.now() - startedAt,
		}
	},

	resume_agent: async (call, { startedAt }) => {
		const input = toolSchemas.resume_agent.parse(call.arguments)
		const updated = await setAgentStatus(input.agentId, 'active')
		if (!updated) {
			return {
				success: false,
				tool: call.name,
				error: 'Agent not found',
				executionMs: Date.now() - startedAt,
			}
		}
		return {
			success: true,
			tool: call.name,
			input,
			result: { id: updated.id, status: updated.status },
			executionMs: Date.now() - startedAt,
		}
	},

	create_automation: async (call, { userId, startedAt }) => {
		const input = toolSchemas.create_automation.parse(call.arguments)
		const created = await createAutomationRecord({
			userId,
			agentId: input.agentId ?? null,
			description: input.description,
			cronExpression: input.cronExpression,
			prompt: input.prompt,
			enabled: input.enabled,
			conversationMode: input.conversationMode,
		})
		return {
			success: true,
			tool: call.name,
			input,
			result: created,
			executionMs: Date.now() - startedAt,
		}
	},

	list_automations: async (call, { userId, startedAt }) => {
		const input = toolSchemas.list_automations.parse(call.arguments)
		const rows = await listAutomationsForUser(userId)
		return {
			success: true,
			tool: call.name,
			input,
			result: rows,
			executionMs: Date.now() - startedAt,
		}
	},

	update_automation: async (call, { userId, startedAt }) => {
		const input = toolSchemas.update_automation.parse(call.arguments)
		const updated = await updateAutomationRecord(userId, input.automationId, {
			agentId: input.agentId,
			description: input.description,
			cronExpression: input.cronExpression,
			prompt: input.prompt,
			enabled: input.enabled,
			conversationMode: input.conversationMode,
		})
		if (!updated) {
			return {
				success: false,
				tool: call.name,
				error: 'Automation not found',
				executionMs: Date.now() - startedAt,
			}
		}
		return {
			success: true,
			tool: call.name,
			input,
			result: updated,
			executionMs: Date.now() - startedAt,
		}
	},

	delete_automation: async (call, { userId, startedAt }) => {
		const input = toolSchemas.delete_automation.parse(call.arguments)
		await deleteAutomationRecord(userId, input.automationId)
		return {
			success: true,
			tool: call.name,
			input,
			result: { deleted: input.automationId },
			executionMs: Date.now() - startedAt,
		}
	},
}
