# LLM Spec

## Overview

The LLM domain is AgentStudio's adapter layer between the application and AI model providers. It wraps the OpenRouter API, provides a typed streaming chat interface, manages the model catalog with per-model pricing and capability metadata, and exposes the `calculateCost()` helper used by the cost domain.

Currently split across two locations — `src/lib/openrouter.server.ts` (chat client) and `src/lib/models/` (model catalog + selector) — which will be consolidated into `src/lib/llm/` as part of the structure refactor.

## Responsibilities

- **Chat completion** — stream chat messages to a model via OpenRouter with tool call support, reasoning tokens, and image input.
- **Model catalog** — list all available models with context windows, pricing, modalities, and capabilities. Cached with a 1-hour TTL.
- **Cost calculation** — given model ID + token counts, return USD cost using live catalog pricing.
- **Model selection UI** — `ModelSelector` component for picking a model across the app.

## Data Model

LLM has no DB tables of its own. The model catalog is fetched from OpenRouter and cached in memory. Pricing data feeds into the `llm_usage` rows owned by the `cost` domain.

## Key Types

### `LlmMessage`

```ts
type LlmMessage = {
	role: 'system' | 'user' | 'assistant' | 'tool'
	content: string | Array<TextContent | ImageContent>
	toolCallId?: string
	reasoning?: string | null
	reasoningDetails?: ReasoningDetail[]
	toolCalls?: Array<{
		id: string
		type: 'function'
		function: { name: string; arguments: string }
	}>
}
```

### `ModelInfo`

```ts
type ModelInfo = {
	id: string
	name: string
	contextLength: number | null
	promptPrice: string // USD per token as string
	completionPrice: string // USD per token as string
	modality?: string | null
	inputModalities?: string[]
	outputModalities?: string[]
	maxCompletionTokens?: number | null
	supportedParameters?: string[]
	// ...
}
```

### `StreamOptions`

Options accepted by `streamChat()`:

| Field         | Type                     | Notes                                              |
| ------------- | ------------------------ | -------------------------------------------------- |
| `model`       | string                   | OpenRouter model ID                                |
| `messages`    | `LlmMessage[]`           | Conversation history                               |
| `tools`       | tool definitions[]       | Optional tool schemas                              |
| `temperature` | number                   | Optional                                           |
| `maxTokens`   | number                   | Optional                                           |
| `reasoning`   | `ReasoningConfig`        | Effort level and token budget for chain-of-thought |
| `onToken`     | `(text: string) => void` | Streaming token callback                           |
| `onToolCall`  | callback                 | Called when a tool call is emitted                 |
| `onUsage`     | `(usage) => void`        | Called with token counts at end of stream          |

## Key Functions

| Function                                    | Purpose                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------ |
| `streamChat(options)`                       | Streams a chat completion; calls callbacks for tokens, tool calls, usage |
| `listModels()`                              | Returns full model catalog from OpenRouter (1h cache)                    |
| `getModel(id)`                              | Returns a single `ModelInfo` by ID                                       |
| `calculateCost(model, tokensIn, tokensOut)` | Returns USD cost as a number using live pricing                          |

## Reasoning Support

Extended thinking / chain-of-thought is configured via `ReasoningConfig`:

```ts
type ReasoningConfig = {
	enabled?: boolean
	exclude?: boolean // exclude reasoning from context window
	effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
	maxTokens?: number
}
```

Reasoning tokens appear in `onToken` with a distinct `reasoning` flag, and are stored separately in message metadata.

## Behavior Contracts

- Model catalog is always fetched fresh if the cache is older than 1 hour. If the OpenRouter API is unavailable, the last cached value is returned.
- `calculateCost()` returns 0 if the model is not found in the catalog — never throws.
- `streamChat()` always calls `onUsage` before resolving, even if the response was empty.
- Tool call arguments are accumulated across streaming chunks before `onToolCall` is fired.

## Configuration

| Env var                | Purpose                           |
| ---------------------- | --------------------------------- |
| `OPENROUTER_API_KEY`   | Required for all LLM calls        |
| `OPENROUTER_SITE_URL`  | Optional — sent as HTTP referer   |
| `OPENROUTER_SITE_NAME` | Optional — sent as X-Title header |

## Rewrite Authority

The current implementation is a baseline, not a constraint. This domain may be rewritten, restyled, reorganized, or replaced as needed to achieve the target product quality. No code path is off-limits if behavior contracts, safety controls, tests, and documentation remain correct.

## UI Contract

This domain follows the shared UX system in [../ui/spec.md](../ui/spec.md).

- Surfaces in this domain must align with the shared desktop/mobile shell patterns.
- Domain-specific states must be explicit in the UI (for example pending, running, blocked, completed) where applicable.
- Blocking user decisions must use the shared action-card and inbox patterns where applicable.

## References
- [../cost/spec.md](../cost/spec.md) — `calculateCost()` is used by cost logging
- [../structure/plan.md](../structure/plan.md) — consolidation of `models/` + `openrouter.server.ts` into `llm/`

