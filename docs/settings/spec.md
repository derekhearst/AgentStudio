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
| `ttsModel`           | text        | OpenRouter speech model for read-aloud (default `hexgrad/kokoro-82m`) |
| `ttsVoice`           | text        | Voice for that model (default `af_heart`); empty = the model's default voice |
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
	taskCompleted: boolean // notify when a research report is finished
	needsInput: boolean // notify when a chat run has waited a minute for an approval or an answer
	agentErrors: boolean // notify when an automation fails for good, or a check fails on an agent's pull request
}
```

Every notification is sent through one place that reads these switches, so a switch that is off stops that kind of notification, in-app and push. Monitor pushes and budget alerts are not covered by a switch: the user turns those off where they set them up. See [../notifications/spec.md](../notifications/spec.md).

**`budgetConfig`**

```ts
{
	dailyLimit: number | null // max USD spend per day (null or 0 = unlimited)
	monthlyLimit: number | null // max USD spend per month
	limitIds?: { day?: string | null; month?: string | null } // the budget_limits rows these two became (set by the server)
}
```

Each limit is enforced as a budget limit (see [../cost/spec.md](../cost/spec.md)): a global limit for its period that blocks new chat and automation runs once spend reaches it, and warns at 80%. The server keeps those limits in step with these fields whenever settings are saved or reset, and again before every budget check. Clearing a limit switches its budget limit off rather than deleting it, so its alert history stays. Before 2026-09-23 these two fields only drew the progress bars in /review; nothing enforced them.

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

The Tool Approval panel lists every AgentStudio tool a chat can call, and each one can be ticked on its own, except three that always ask: `push_branch`, `create_pull_request` and `request_plan_approval`. Those show ticked, marked "always asks", and cannot be unticked, and the **All** and **None** buttons leave them alone, because they ask for approval in every mode whatever is stored. `ask_user` is left off, because it is a question to you rather than an action, and no approval setting ever reaches it. The panel's old "Always loaded" and "Searchable" groups and its "Programmatic tool calling" switch are gone, because none of them did anything in a chat (#8, #69). A stored row may still carry `programmaticToolCallingEnabled`; nothing reads it, and the next save drops it. See [../tools/tools.md](../tools/tools.md).

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
- **Reset** puts every setting back to its default — the default model, the transcription model, the read-aloud model and voice, notifications, budget, context, tools and memory — in one step. Settings added later are included automatically, because Reset works from the same list of defaults that a new user starts with. Reset clears both budget limits and switches off the budget limits they were enforced through, so nothing goes on blocking at the old amount.
- After **Save** or **Reset**, other pages read the new values straight away. For example, a chat started from the home page uses the default model you just saved, not the one from before.
- Settings are consumed by multiple domains at runtime: `contextConfig` by context assembly, `budgetConfig` by cost enforcement, `memoryConfig` by memory recall, `toolConfig` by tool execution, `notificationPrefs` by notification dispatch.

## Settings UI

The `/settings` route provides a UI for all editable settings grouped by category:

- **Models** — default model, transcription model, and the read-aloud model and voice (picked from OpenRouter's speech catalogue, with a preview button; see [../speech/speech.md](../speech/speech.md)). Reset returns the read-aloud pair to its defaults. The Auto-read switch is not a setting: it is stored per device in the browser.
- **Memory** — enable/disable, top-k, reranking
- **Context** — compaction thresholds
- **Budget** — daily/monthly limits, enforced; alerts at 80% and 100%
- **Tools** — approval-required list: one tickable entry per tool (the three always-ask tools locked on), plus a switch that requires approval for every tool
- **Notifications** — per-category toggles
- **Appearance** — theme selection
- **Job queue** (`/settings/jobs`) and **Hook invocations** (`/settings/hooks`) — admin views of background work. **Refresh** fetches the latest rows from the server, and if they cannot be loaded the page shows the reason instead of a spinner.
- **System** (read-only) — a checklist of what the deployment provides: the database and its migrations, the Claude sign-in, the workspace folder, the shell sandbox, the model gateway, and each integration (OpenRouter, web search, GitHub, webhooks, push, external cron). Each row says whether it is in place and names the environment variable that controls it, never its value. These are deploy-time settings, not stored in `appSettings` — first run collects only the owner account (see [../auth/auth.md](../auth/auth.md)).


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

- Surfaces: `/settings` category panels (models, memory, context, budget, tools, notifications, appearance). A prompt preview panel was planned; its data query (`getFullPromptPreview`) was never called by any page and was deleted (#8).
- States and badges: clean, unsaved, saving, saved, validation-error, and out-of-policy.
- Save behavior: edits are section-scoped, optimistic when safe, and show rollback on write failure; unsaved changes warn before navigation.
- Blocking actions: lowering budget caps below current spend and disabling required safety controls require explicit confirmation.
- Mobile behavior: settings sections render as stacked accordions with sticky save/discard actions and clear section-level validation summaries.
- Accessibility: every toggle/slider/select has a persistent label and helper text; validation errors are announced and linked.
