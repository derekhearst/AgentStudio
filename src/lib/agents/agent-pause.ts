import { listAutomationsQuery } from '$lib/automations'
import { getAgent, getAgentChoices, listAgents, setAgentPausedCommand } from './agents.remote'

/**
 * Pause or resume an agent from a page (#66), then refresh every cached read that shows its
 * status: the /agents list, this agent's detail, the agent picker on /automations, and the
 * automation cards that say their agent is paused.
 *
 * Remote queries answer a repeat call from the client cache, so without the refresh a page
 * visited earlier would keep showing the old status until a full reload. Settled rather than
 * all-or-nothing: the change has already been made, and a failed refresh must not report it
 * as a failed pause.
 */
export async function setAgentPausedFromPage(agentId: string, paused: boolean) {
	const agent = await setAgentPausedCommand({ agentId, paused })
	await Promise.allSettled([
		listAgents().refresh(),
		getAgent(agentId).refresh(),
		getAgentChoices().refresh(),
		listAutomationsQuery().refresh(),
	])
	return agent
}
