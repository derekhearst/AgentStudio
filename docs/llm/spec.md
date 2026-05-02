# LLM Spec

## Overview

The LLM domain is AgentStudio's adapter layer between the application and AI model providers. It wraps the OpenRouter API, provides typed chat and streaming interfaces, manages the model catalog with per-model pricing and capability metadata, and provides model data used by the costs domain.

The implementation is consolidated under `src/lib/llm/`.

## Responsibilities

- **Chat completion** — stream chat messages to a model via OpenRouter with tool call support, reasoning tokens, and image input.
- **Model catalog** — list all available models with context windows, pricing, modalities, and capabilities. Cached with a 1-hour TTL.
- **Cost calculation** — given model ID + token counts, return USD cost using live catalog pricing.
- **Model selection UI** — `ModelSelector` component for picking a model across the app.

## Data Model

LLM has no DB tables of its own. The model catalog is fetched from OpenRouter and cached in memory. Pricing data feeds into the `llm_usage` rows owned by the `costs` domain.

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

## Retry Behavior

`streamChat()` retries automatically on transient failures before propagating an error to the caller:

- **Retried:** HTTP 5xx responses, network timeouts, connection resets.
- **Not retried:** HTTP 4xx responses (bad request, auth failure, model not found) — these are caller bugs, not transient failures.
- **Retry policy:** up to 3 attempts with exponential backoff starting at 500 ms, capped at 5 s. Each attempt re-opens the stream from the beginning (there is no partial-stream resume).
- If all attempts fail, `streamChat()` throws a typed `LlmError` with `{ attempt, statusCode, message }`.

OpenRouter availability is not treated as a special case. If the service is down, retries exhaust and the run fails normally — there is no fallback provider.

`listModels()` is not retried. If the catalog fetch fails, the last in-memory cache is returned regardless of age. If there is no cache, an empty array is returned.

## Behavior Contracts

- `calculateCost()` returns 0 if the model is not found in the catalog — never throws.
- `streamChat()` always calls `onUsage` before resolving, even if the response was empty.
- Tool call arguments are accumulated across streaming chunks before `onToolCall` is fired.
- Retry attempts are transparent to callers — `onToken`, `onToolCall`, and `onUsage` are only called for the successful attempt.

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

- [../cost/spec.md](../cost/spec.md) — model pricing metadata is used by cost logging
- [../structure/plan.md](../structure/plan.md) — domain structure and ownership boundaries
