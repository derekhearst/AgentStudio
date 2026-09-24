# Models and engine backends

This page describes, in plain English, which AI models a chat can run on, what each one costs, and how an operator turns on models other than Claude. For the adapter code and the OpenRouter calls behind the app's smaller features, see [spec.md](spec.md).

## Overview

Every chat turn runs on the **engine**: the Claude Agent SDK, which drives the Claude Code program behind the scenes. The engine can reach a model in one of two ways, called **backends**:

| Backend | Which models | What it costs | Default |
| --- | --- | --- | --- |
| **Subscription** | The current Claude models Claude Code can run (see below) | Nothing per token. The turn runs on the Claude subscription that Claude Code is signed in with. | Always on |
| **Gateway** | Any other model the gateway serves (Kimi, GPT, GLM, a local model…) | Billed per token by the gateway provider. | Off |

The gateway is off unless the operator sets it up. With it off, only Claude models are offered anywhere a chat's model is chosen, so it is not possible to pick a model that cannot run.

### Which Claude models are offered

The subscription list is a fixed list of the Claude models the bundled Claude Code program can run: Claude Fable 5.1 and 5, Opus 5, 4.8, 4.7, 4.6 and 4.5, Sonnet 5, 4.6 and 4.5, and Haiku 4.5. It is taken from Claude Code's own model table, less the models Anthropic has retired (the Claude 3 family, Sonnet 4, Opus 4 and Opus 4.1).

OpenRouter's catalogue is not used to decide this. It still lists retired Claude models, and some under names that are not Anthropic model ids at all: its "Claude Sonnet 4" is `anthropic/claude-sonnet-4`, which Claude Code would refuse on the first message. The catalogue only supplies a model's description and context size. Every subscription model is offered even when OpenRouter cannot be reached, because running one does not involve OpenRouter.

When the app's Claude Code is upgraded and knows a new model, a developer adds it to the list (`SUBSCRIPTION_MODEL_IDS` in `src/lib/engine/model-backend.ts`). Until then the pickers do not offer it.

The app's smaller features — conversation titles, memory, monitors' yes/no checks, evaluations, image and speech — do not use the engine. They call OpenRouter directly with `OPENROUTER_API_KEY` and are unaffected by anything on this page.

## Key concepts

| Term | Meaning |
| --- | --- |
| **Engine model** | A model a chat turn can run on here: a current Claude model, or a model the configured gateway serves that can use tools. |
| **Model catalogue** | OpenRouter's public list of models with their names, context sizes and prices. The pickers use it for names and prices; the usage ledger uses it for prices. |
| **Gateway** | A service that accepts requests in Anthropic's format and forwards them to another model. OpenRouter offers one at `https://openrouter.ai/api`; a self-hosted LiteLLM proxy is another. |
| **Model id** | The name a model is asked for by. The engine spells Claude models the way Claude Code does (`claude-haiku-4-5`); OpenRouter spells the same model `anthropic/claude-haiku-4.5`. The app converts between them automatically. |

## Where a model is picked

Three pickers choose the model a chat runs on. All three list only engine models:

1. **The chat composer**, for the conversation in front of you: its model pill, and the `/model` command in its `/` palette, which lists the same models (a gateway row there says "Gateway · paid" beside its id).
2. **Settings → Model & AI → Default Model**, for new conversations.
3. **An agent's configuration** (`/agents/[id]`), for conversations that agent starts — from a monitor, a pull-request fix, and so on.

Each row in these pickers is labelled:

- **Subscription** / *Included* — a Claude model. No per-token cost.
- **Gateway · paid** with its price per million tokens — a gateway model. *Price unknown* means the gateway serves it but OpenRouter's catalogue has no price for it (a local model, for example).

A note at the top of the picker says which backends are available. When a conversation is already on a model that cannot run — it was set before the gateway was turned off, say — the composer marks it **Unavailable** next to the model name. A gateway model is marked **Paid**.

The **Transcription Model** picker is different: transcription calls OpenRouter directly, so it still lists OpenRouter's whole catalogue.

## User flows

### Choosing a model for a chat

1. Open the model picker in the composer.
2. Pick a row. Claude rows run on the subscription; gateway rows are billed per token.
3. Send a message. If the model is a gateway model, the reasoning control is switched off (see Business rules).

### Sending a message on a model that cannot run

1. The conversation's model cannot run here: a non-Claude model with no gateway configured, or a Claude model that has been retired (an older conversation on Claude Sonnet 4, say).
2. The composer already shows **Unavailable** beside the model. Hovering over it says why.
3. On **Send**, the server refuses the turn straight away. For a non-Claude model the message names the model and the two settings that would fix it; for a retired Claude model it says the model can no longer run. Nothing is saved — no message, no failed run — so the conversation is unchanged, and the message does not stay on screen as if it had been sent. **Retry** keeps the text.
4. Pick a model from the list and send again.

### Turning the gateway on (operator)

1. Set `LLM_GATEWAY_URL` and `LLM_GATEWAY_TOKEN` in the server's environment (`.env`, or the host's environment for Docker).
2. For OpenRouter: `LLM_GATEWAY_URL="https://openrouter.ai/api"`, and the token is an OpenRouter API key.
3. Restart the server. Settings → System shows **Model gateway** as configured.
4. The pickers now also list the models the gateway reports at `{LLM_GATEWAY_URL}/v1/models`, labelled **Gateway · paid**. A model OpenRouter's catalogue says cannot use tools, or cannot answer in text, is left out (see Business rules).

To turn it off again, clear either variable and restart.

## Roles and permissions

AgentStudio has one owner. The owner picks models in all three pickers. Only the operator — whoever controls the server's environment — can turn the gateway on or off. Saving a model that cannot run is refused by the server, not just hidden in the picker: a default model or an agent's model can only be changed to a model something here can run. The same rule holds when the chat agent changes an agent's model itself with its `update_agent` tool: the tool answers with the reason and saves nothing from that call.

## Integrations

| System | Used for |
| --- | --- |
| **Claude Code** (via the Agent SDK) | Runs every chat turn. Signed in with the Claude subscription for Claude models. |
| **OpenRouter model catalogue** | Names, context sizes and prices for the pickers and the ledger. |
| **The gateway** (`LLM_GATEWAY_URL`) | Serves non-Claude models to the engine, and lists them at `/v1/models`. |

### What a gateway run is given

The Claude Code process for a gateway turn gets only what the gateway needs:

- the gateway's address and token (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`), and `ANTHROPIC_API_KEY` set to empty — OpenRouter's guide requires that, because a key there can send the request to Anthropic instead;
- the chosen model for every job Claude Code does on its own — the main loop, its small helper calls and any subagent it hands work to — so nothing quietly asks the gateway for a (paid) Claude model;
- not the Claude subscription's login token, which a paid gateway run has no use for.

Nothing else from the server's environment reaches it, the same as for any turn (see [../runtime/spec.md](../runtime/spec.md)).

## Business rules

- **Claude always runs on the subscription.** Even when the gateway also serves Claude, a Claude model is never sent through it — including a retired one, which is simply refused.
- **Only current Claude models run.** A Claude model not on the subscription list is refused everywhere a model is used: it is not offered in a picker, a send on it is refused before anything is saved, a default model or agent model cannot be changed to it, and a subagent set to it uses its parent's model instead.
- **Off by default.** No gateway settings means Claude only. Both `LLM_GATEWAY_URL` and `LLM_GATEWAY_TOKEN` are needed; an empty value counts as unset.
- **Only models the gateway serves are offered.** If the gateway's model list cannot be fetched, no gateway models are offered (the app retries a minute later) rather than guessing.
- **Only gateway models that can use tools are offered.** Claude Code sends its tools with every request and expects a text answer. A model OpenRouter's catalogue lists without tool support, or that answers only in images or audio, would fail on the first message, so it is left out. A model the catalogue does not list at all (a local model behind LiteLLM) is offered, since nothing says it cannot run.
- **Reasoning is off on gateway models.** Claude's adaptive thinking and effort levels are Anthropic features; whether a gateway passes them on to another model is unverified, so a gateway turn runs with thinking off and the composer's reasoning control is disabled, as is its `/effort` command, which says why instead of opening its list.
- **Cost.** A Claude turn records its tokens and $0. A gateway turn is priced from OpenRouter's catalogue over that turn's own tokens — input, output, and cached prompt tokens at the catalogue's cache prices where it lists them. The ledger row notes `backend: gateway` and where the price came from (`costBasis`): `catalogue`, or `cli-estimate` for a model the catalogue does not price (Claude Code's own estimate), or `unpriced` when there is neither. An unpriced turn is recorded like any other call the ledger cannot price: at $0, marked unpriced with the reason, and with a warning in the server log. Claude Code's own estimate is not used when the catalogue has a price, because for a model it does not know it guesses at a Claude rate.
- **Budgets apply.** Gateway turns count toward budget limits like any other metered spend.
- **Tool use is weaker off Claude.** Claude Code is built for Claude models; OpenRouter says other models may not work correctly through it, and multi-step tool use is where they fall short. The gateway is a deliberate, labelled choice, never a default.
- **Switching backends mid-conversation** keeps the same agent session. Whether every gateway model accepts a session that started on Claude has not been checked against a live gateway; if one refuses, start a new conversation for it.
- **Stored ids are tidied.** A Claude model saved in OpenRouter's spelling (`anthropic/claude-haiku-4.5`) is stored and sent as `claude-haiku-4-5`, and in lower case, as Claude Code spells every Claude model. Tidying only fixes the spelling: whether the model can run is the subscription list's decision. A gateway model's id is left exactly as given, since the gateway reads it.
- **Claude Code's short names are Claude.** Claude Code also takes short names it resolves itself — `opus`, `sonnet`, `haiku`, `fable`, `best` and `opusplan`, each with an optional `[1m]` for the one-million-token window. Every one of them runs on the subscription and is never sent to the gateway.
- **The context window comes from the engine list.** The chat page sizes its context bar, and decides whether to compact before a switch to a model with a smaller window, from the same list the pickers use. So a Claude model reads its real window whichever way its id is spelled, and switching an older conversation from `anthropic/claude-sonnet-4.5` to the picker's `claude-sonnet-4-5` is not mistaken for a move to a smaller window. A model the list cannot describe is assumed to have 128K tokens.

## Configuration

| Variable | Purpose |
| --- | --- |
| `LLM_GATEWAY_URL` | Optional. The gateway's base address, e.g. `https://openrouter.ai/api`. |
| `LLM_GATEWAY_TOKEN` | Optional. The gateway's key, e.g. an OpenRouter API key. |

Both are passed through `docker-compose.yml` and default to empty (off). For a self-hosted LiteLLM proxy, pin a known-good version and never use LiteLLM 1.82.7 or 1.82.8.
