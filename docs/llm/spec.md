# LLM Spec

## Overview

The LLM domain is AgentStudio's adapter layer between the application and AI model providers. It wraps the OpenRouter API, provides typed chat and streaming interfaces, manages the model catalog with per-model pricing and capability metadata, and provides model data used by the costs domain.

The implementation is consolidated under `src/lib/llm/`.

Which models a *chat* can run on — Claude on the subscription, or other models through an optional gateway — is described in plain English in [llm.md](llm.md).

## Responsibilities

- **Chat completion** — stream chat messages to a model via OpenRouter with tool call support, reasoning tokens, and image input.
- **Model catalog** — list all available models with context windows, pricing, modalities, and capabilities. Cached with a 1-hour TTL.
- **Cost calculation** — given model ID + token counts, return USD cost using live catalog pricing.
- **Model selection UI** — `ModelSelector` component for picking a model across the app. With `surface="engine"` (the chat composer, the default model, an agent's model) it lists only models the engine can run, from `getEngineModels`, labelled Subscription or Gateway · paid; otherwise (transcription) it lists OpenRouter's whole catalogue from `getAvailableModels`.
- **Text-to-speech** — `tts.server.ts` turns reply text into MP3 through OpenRouter's speech endpoint, prices it from the separate speech-model catalogue (speech models are not in the chat-model list), checks budget limits and records the spend under `tts`. See [../speech/speech.md](../speech/speech.md).

## Model ids

The app keeps two spellings of a Claude model. The Agent SDK engine uses Anthropic's bare id (`claude-haiku-4-5`), and since the engine migration that is what the app's defaults and stored settings hold. OpenRouter, which the rest of the app still calls directly (research, memory mining and reranking, monitors, titles, automations, the legacy runtime loop), only accepts its own catalogue names (`anthropic/claude-haiku-4.5`) and refuses anything else. So `chat()` and `streamChat()` convert before sending (`toOpenRouterModelId` in `src/lib/llm/openrouter-model.ts`), and the usage ledger looks prices up with the same conversion:

| Stored id | Sent to OpenRouter |
| --- | --- |
| `claude-sonnet-5` | `anthropic/claude-sonnet-5` |
| `claude-haiku-4-5`, `claude-haiku-4-5-20251001`, `claude-sonnet-4-5[1m]` | `anthropic/claude-haiku-4.5`, `anthropic/claude-haiku-4.5`, `anthropic/claude-sonnet-4.5` |
| `anthropic/claude-sonnet-4-6` | `anthropic/claude-sonnet-4.6` |
| `openai/gpt-4o-mini`, or an alias such as `sonnet` | unchanged |

A bare Claude id gains the `anthropic/` prefix, loses any snapshot date or `[1m]` suffix, and has its version written with a dot. Only ids it can map with certainty are changed; anything else goes to OpenRouter as written, so OpenRouter's own error names it. Callers that log usage log the converted id, since that is the one the model catalogue prices. Before 2026-09-23 the bare id was sent as-is, so every research run failed at its first planner call, every memory extraction and rerank quietly degraded, and the few calls that did succeed were priced at nothing.

The other direction is `normalizeModelId` in `src/lib/engine/model-backend.ts`: an OpenRouter Claude slug becomes the engine's id (`anthropic/claude-haiku-4.5` → `claude-haiku-4-5`: prefix stripped, dotted version dashed). Non-Anthropic ids are left alone — they are the gateway's ids.

## Engine backends

The chat engine runs a Claude model on the Claude Code subscription and anything else through an Anthropic-compatible gateway, only when `LLM_GATEWAY_URL` and `LLM_GATEWAY_TOKEN` are set. `modelBackend()` in `src/lib/engine/model-backend.ts` answers `subscription`, `gateway` or `unavailable` for a model; the picker, the stream route (which refuses `unavailable` before saving anything), the default-model and agent-model saves, and `buildEngineOptions` all use it. The gateway's environment is built by `buildGatewayEnv()` (`src/lib/engine/gateway-env.ts`); a gateway turn is priced by `gatewayTurnCost()` (`src/lib/engine/gateway-cost.ts`) from the catalogue, cache prices included. `getEngineModels` builds the engine list with `buildEngineModelList()` (`src/lib/llm/engine-models.ts`) from the catalogue's Anthropic models plus, with a gateway, the ids the gateway lists at `/v1/models` (`src/lib/llm/gateway-models.server.ts`, cached an hour, a failure retried after a minute). See [llm.md](llm.md) for the rules in plain English.

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
	cacheReadPrice?: string | null // per cached prompt token read, when the catalogue lists one
	cacheWritePrice?: string | null // per prompt token written to the cache, when listed
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
| `model`       | string                   | OpenRouter model ID, or a bare Claude id           |
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
| `toOpenRouterModelId(id)`                   | Translates a stored model id into the one OpenRouter knows (see Model ids) |
| `synthesizeSpeech(input)`                   | One chunk of text → MP3 via OpenRouter; budget-checked, ledgered as `tts` |
| `listSpeechModels()`                        | OpenRouter's speech models with per-character price and voices (1h cache; a failed fetch is retried after a minute) |

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

- A call whose model has no catalogue price is never recorded as free without a word: the usage ledger marks the row unpriced and logs a warning (see [../cost/spec.md](../cost/spec.md)). A failed catalogue refresh keeps pricing from the previous copy.
- `streamChat()` always calls `onUsage` before resolving, even if the response was empty.
- Tool call arguments are accumulated across streaming chunks before `onToolCall` is fired.
- Retry attempts are transparent to callers — `onToken`, `onToolCall`, and `onUsage` are only called for the successful attempt.

## Configuration

| Env var                | Purpose                           |
| ---------------------- | --------------------------------- |
| `OPENROUTER_API_KEY`   | Required for all LLM calls        |
| `OPENROUTER_SITE_URL`  | Optional — sent as HTTP referer   |
| `OPENROUTER_SITE_NAME` | Optional — sent as X-Title header |
| `LLM_GATEWAY_URL`      | Optional — the chat engine's gateway for non-Claude models, e.g. `https://openrouter.ai/api`. Off when unset |
| `LLM_GATEWAY_TOKEN`    | Optional — the gateway's key (an OpenRouter key for OpenRouter). Off when unset |

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
