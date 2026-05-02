# Settings Spec

## Overview

Settings stores per-user application preferences that control model selection, memory behavior, context compaction, tool approval policy, notification preferences, and UI theme. Dream run configuration has been removed — background memory work is now managed by the memory domain. Settings are user-scoped — each user has one settings row, created with defaults on first access. Settings are read on every request that needs them; they are not system-wide.

## Data Model

### `appSettings` table

One row per user. Created with defaults when the user first accesses settings.

| Column               | Type        | Notes                                             |
| -------------------- | ----------- | ------------------------------------------------- |
| `id`                 | uuid        | Primary key                                       |
| `userId`             | uuid        | FK → `users` (nullable means global/unowned)      |
| `defaultModel`       | text        | OpenRouter model ID for chat/agents               |
| `transcriptionModel` | text        | OpenRouter model ID for audio transcription       |
| `notificationPrefs`  | jsonb       | See notification prefs shape below                |
| `budgetConfig`       | jsonb       | Daily / monthly spend limits                      |
| `contextConfig`      | jsonb       | Compaction thresholds and model                   |
| `toolConfig`         | jsonb       | Tools that require explicit approval per-request  |
| `memoryConfig`       | jsonb       | Memory retrieval and mining settings              |
| `systemPrompt`       | text        | **Deprecated** — kept for migration compatibility |
| `theme`              | text        | UI theme name                                     |
| `createdAt`          | timestamptz |                                                   |
| `updatedAt`          | timestamptz |                                                   |

### JSONB field shapes

**`notificationPrefs`**

```ts
{
	taskCompleted: boolean // notify when task finishes
	needsInput: boolean // notify when agent needs answer
	agentErrors: boolean // notify on agent hard errors
}
```

**`budgetConfig`**

```ts
{
	dailyLimit: number | null // max USD spend per day (null = unlimited)
	monthlyLimit: number | null // max USD spend per month
}
```

**`contextConfig`**

```ts
{
	reservedResponsePct: number // % of context window reserved for response (default 30)
	autoCompactThresholdPct: number // compact when context exceeds this % of usable window (default 72)
	compactionModel: string // model used for context compaction summaries
}
```

**`toolConfig`**

```ts
{
  approvalRequiredTools: string[]   // tool names that always require user approval
}
```

**`memoryConfig`**

```ts
{
	enabled: boolean // whether memory recall is active
	topK: number // number of memories to retrieve per turn
	useRerank: boolean // whether to rerank memories after retrieval
	rerankModel: string // model for reranking
	embeddingModel: string // model for memory embeddings
	autoMine: boolean // whether to automatically extract memories after conversations
}
```

## Key Behaviors

- **`getSettings(userId)`** — returns the user's settings, creating defaults if the row does not exist. All callers use this — never query `appSettings` directly.
- **`updateSettings(userId, patch)`** — accepts a partial patch and merges it. JSONB fields are merged at the top level (not deep-merged). Callers must pass the full JSONB object for any nested field they want to change.
- Settings are consumed by multiple domains at runtime: `contextConfig` by context assembly, `budgetConfig` by cost enforcement, `memoryConfig` by memory recall, `toolConfig` by tool execution, `notificationPrefs` by notification dispatch.

## Settings UI

The `/settings` route provides a UI for all editable settings grouped by category:

- **Models** — default model, transcription model
- **Memory** — enable/disable, top-k, reranking
- **Context** — compaction thresholds
- **Budget** — daily/monthly limits
- **Tools** — approval-required list
- **Notifications** — per-category toggles
- **Appearance** — theme selection

The `PromptPreviewPanel` component provides an inline preview of how the assembled system prompt will look given current settings, used on the agent and settings pages.

## Roles & Permissions

| Action                         | Who can do it       |
| ------------------------------ | ------------------- |
| Read and update own settings   | Authenticated users |
| Read another user's settings   | Admin only          |
| Update another user's settings | Admin only          |

## Rewrite Authority

The current implementation is a baseline, not a constraint. This domain may be rewritten, restyled, reorganized, or replaced as needed to achieve the target product quality. No code path is off-limits if behavior contracts, safety controls, tests, and documentation remain correct.

## UI Contract

This domain follows the shared UX system in [../ui/spec.md](../ui/spec.md).

- Surfaces: `/settings` category panels (models, memory, context, budget, tools, notifications, appearance) plus prompt preview panel.
- States and badges: clean, unsaved, saving, saved, validation-error, and out-of-policy.
- Save behavior: edits are section-scoped, optimistic when safe, and show rollback on write failure; unsaved changes warn before navigation.
- Blocking actions: lowering budget caps below current spend and disabling required safety controls require explicit confirmation.
- Mobile behavior: settings sections render as stacked accordions with sticky save/discard actions and clear section-level validation summaries.
- Accessibility: every toggle/slider/select has a persistent label and helper text; validation errors are announced and linked.
