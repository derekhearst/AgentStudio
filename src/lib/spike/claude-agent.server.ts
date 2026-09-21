/**
 * Spike: drive the Claude Agent SDK with AgentStudio's own tools.
 *
 * This exists to prove one thing — that an existing AgentStudio capability can
 * be handed to the Agent SDK as an in-process tool. If that holds, the agent
 * loop becomes Anthropic's problem while the tools stay ours, and most of
 * src/lib/{chat,runtime,runs,context} can be deleted.
 *
 * Auth note: the SDK does NOT read an API key. It spawns the Claude Code CLI
 * and uses its existing login, so this runs on the subscription.
 */

import { createSdkMcpServer, tool, type Options } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { generateImage, type ImageModel, type ImageSize } from '$lib/tools/image-gen.server'

export const SPIKE_MCP_SERVER_NAME = 'agentstudio'

const generateImageTool = tool(
	'generate_image',
	'Generate an image from a text prompt and return its URL. Use whenever the user asks for a picture, illustration, logo, or any visual.',
	{
		prompt: z.string().min(1).describe('What the image should depict'),
		model: z.enum(['flux', 'sdxl', 'dall-e']).default('flux').describe('Image model to use'),
		size: z.enum(['256x256', '512x512', '1024x1024']).default('1024x1024'),
	},
	async ({ prompt, model, size }) => {
		try {
			const result = await generateImage(prompt, model as ImageModel, size as ImageSize)
			return {
				content: [
					{
						type: 'text' as const,
						text: `Generated with ${result.model} at ${result.size} (cost $${result.cost}): ${result.url}`,
					},
				],
			}
		} catch (error) {
			// Report the failure as tool output instead of throwing. For this spike a
			// reached-but-failed tool still proves the bridge works, and it keeps a
			// missing OPENROUTER_API_KEY from looking like an SDK problem.
			const message = error instanceof Error ? error.message : String(error)
			return {
				content: [{ type: 'text' as const, text: `Image generation failed: ${message}` }],
				isError: true,
			}
		}
	},
	{ annotations: { readOnlyHint: false, openWorldHint: true } },
)

export const spikeToolServer = createSdkMcpServer({
	name: SPIKE_MCP_SERVER_NAME,
	version: '0.0.1',
	tools: [generateImageTool],
	instructions: "AgentStudio's own in-process tools.",
})

/** MCP namespaces tool names as mcp__<server>__<tool>. */
export const SPIKE_IMAGE_TOOL = `mcp__${SPIKE_MCP_SERVER_NAME}__generate_image`

/**
 * Only our one tool is allowed. The SDK's built-in Read/Write/Edit/Bash stay
 * off so the spike cannot touch the filesystem while we are evaluating it.
 */
export const spikeOptions: Options = {
	model: 'claude-opus-5',
	mcpServers: { [SPIKE_MCP_SERVER_NAME]: spikeToolServer },
	allowedTools: [SPIKE_IMAGE_TOOL],
	permissionMode: 'default',
	maxTurns: 6,
}
