# Connectors (MCP) — technical reference

The overview, flows and rules in plain English are in [mcp.md](mcp.md). This page is the reference behind them: the table, where each check lives, and the contracts the specs pin.

This replaces an earlier pre-SDK design (capability groups and `enable_capability`, a name-based auto-approve rule, `mcpServerTools` / `mcpServerAssignments` tables, an `MCP_SECRET_KEY`). None of that was built; the engine is now the Claude Agent SDK, and connectors are built on it.

## Data model

### `mcp_servers` (migration `0079_mcp_servers`)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid | Primary key. Trust is keyed on this row. |
| `user_id` | uuid | FK `users.id`, cascade delete. |
| `name` | text | The SDK `mcpServers` key and the `<server>` in `mcp__<server>__<tool>`. Validated by `connectorNameProblem`; unique per user (`mcp_servers_user_name_unique`); never updated. |
| `label` | text | Display name, at most 80 characters. |
| `transport` | enum `mcp_transport` | `http` or `sse`. |
| `url` | text | Validated by `checkMcpUrl`; stored as the parsed `href`. |
| `header_names` | text[] | Names of the stored headers, sorted. Values are only in `encrypted_secrets`. |
| `has_bearer_token` | boolean | Whether the encrypted document holds a token. |
| `encrypted_secrets` | text, nullable | `encryptSecret(JSON.stringify({ v: 1, bearerToken, headers }))` with `APP_ENCRYPTION_KEY`; null when there are no secrets. Never selected by the list query. |
| `tool_policies` | jsonb | `{ [toolName]: 'allow' \| 'block' }` keyed by the name `tools/list` reported. `ask` is the default and is not stored. At most 500 entries. |
| `tools_snapshot` | jsonb | The last successful test's tools: `{ name, title, description, readOnly, destructive, openWorld }`. Display only. |
| `enabled` | boolean | Default true. |
| `timeout_ms` | integer, nullable | Per-call timeout handed to the SDK (1 000 – 600 000). |
| `last_tested_at`, `last_test_ok`, `last_error` | | The last Test outcome. Cleared when transport, URL or the secrets actually change. |
| `created_at`, `updated_at` | timestamptz | |

Index `mcp_servers_user_idx` on `user_id`. Audit actions `mcp_server.created`, `mcp_server.updated`, `mcp_server.deleted` were added to `audit_action`.

## Modules

| Module | Role |
| --- | --- |
| `src/lib/engine/mcp-connectors.ts` | Pure. Name rule, the run's connector map (`buildRunMcpConnectors`), `connectorCallVerdict`, `connectorDisallowedTools`, `composeMcpServers`. |
| `src/lib/engine/permission-mode.ts` | `resolveToolGate` applies an external tool's policy (`externalPolicy`). |
| `src/lib/engine/tool-decision.ts` | `decideToolCall` takes the SDK's provenance and consults `connectorCallVerdict` after the scope check and before containment and the gate. |
| `src/lib/mcp/mcp-config.ts` | Pure. URL, header, token and timeout rules; the secrets document and its edit patch; the SDK config. Shared with the settings form. |
| `src/lib/mcp/mcp.server.ts` | CRUD scoped to the caller, the Test button's bookkeeping, `loadRunMcpServers`. |
| `src/lib/mcp/mcp-probe.server.ts` | The Test button's MCP client (`@modelcontextprotocol/sdk`), through `createGuardedFetch`. |
| `src/lib/tools/egress-fetch.server.ts` | A `fetch` behind the egress guard: spelling check, per-socket address check (`guardedLookup`), no redirects, capped streamed body. |
| `src/lib/mcp/mcp.remote.ts` | Remote functions: list, create, update, set enabled, set tool policies, delete, test. Each opens with `requireAuthenticatedRequestUser()`. |
| `src/routes/settings/connectors/+page.svelte` | The page; `McpServerForm.svelte` and `McpToolPolicyList.svelte` in `src/lib/mcp/`. |

## Run start

`loadRunMcpServers({ userId, runSource, toolScoped })`, called by the chat stream route beside the other per-run loads:

1. Returns nothing unless `runSource === 'chat_stream'` and the agent has no fixed tool list.
2. Loads the user's enabled rows, oldest first.
3. Per row: the name rule, `checkMcpUrl` (with the current `MCP_ALLOWED_PRIVATE_HOSTS`), decrypting the secrets, and resolving the host with `assertPublicUrl` (3 s limit; exempt hosts skip it). A row failing any of these is skipped with a reason.
4. Returns `servers` (SDK configs), `connectors` (the map the gate reads), `disallowedTools` (`mcp__<name>__<tool>` for every `block`), `skipped`, and one `mcp_unavailable` notice (not persisted) naming the skipped rows. Never throws.

`buildEngineOptions` then sets:

- `mcpServers = composeMcpServers({ own, external, scoped })` — connectors first, `agentstudio` last so no key can shadow it; an external key that fails the name rule is dropped; a scoped run gets none.
- `strictMcpConfig: true` on every run.
- `disallowedTools` += `ListMcpResourcesTool`, `ReadMcpResourceTool`, `ReadMcpResourceDirTool`, and (unscoped runs) the connectors' blocked tools.

External names are never added to `allowedTools`, which the SDK treats as an auto-allow list.

## Deciding a call

For a name `mcp__<server>__<tool>` whose server is not `agentstudio`, `decideToolCall` with the run's connector map:

1. Out of scope for a fixed tool list → deny.
2. Provenance names `agentstudio` with a source other than `sdk` → deny.
3. `<server>` is not one of the run's connectors → deny.
4. Provenance present and not `{ source: 'dynamic', name: <server> }` → deny.
5. Policy = the row's entry for `cliToolNameSegment(<tool>)` (two names the CLI spells alike take the stricter), else `ask`. With no provenance reported (`null`), `allow` becomes `ask`.
6. `resolveToolGate`: mandatory-approval tools first (none are external); then `block` → deny in every mode; in `default` / `acceptEdits`, `allow` → allow unless `settingsRequiresApproval` (for an external name, only the `'*'` wildcard) → ask; `ask` → ask; `plan` → deny; `bypassPermissions` → allow.

The PreToolUse hook and `canUseTool` pass the SDK's `mcp_server` / `mcpServer`. The frame the chat shows when the model announces a call is decided with provenance `undefined` (not yet reported), which applies the row's policy; the hook and `canUseTool` decide again with what the SDK reported. Runs that pass no connector map (automations) keep the earlier posture: every external tool asks, and with no approval surface is refused.

## Notices

- `system/init` whose `mcp_servers` lists a non-`sdk` server as `failed` or `needs-auth` → one persisted `mcp_unavailable` warning naming them (names reduced to `[a-zA-Z0-9_-]`, 40 characters). `pending` is ignored.
- Skipped at run start → one live-only `mcp_unavailable` warning.

## The connection test

`probeMcpServer({ transport, url, headers, allowedPrivateHosts?, timeoutMs? })`:

- `StreamableHTTPClientTransport` or `SSEClientTransport`, both given the guarded fetch, which every request (including the SSE stream and its POST endpoint) goes through.
- One 10 s deadline for the whole exchange; aborting it tears down any open stream. `connect`, then `tools/list` only if the server declares the `tools` capability, following `nextCursor` for at most 20 pages / 500 tools.
- 401 / `UnauthorizedError` → `needsAuth` with "wants credentials" or "refused the credentials"; 403, 404, 405 (HTTP transport), egress refusals, timeouts, `ENOTFOUND`, `ECONNREFUSED` each get their own message. Anything else is quoted with every header value, and a bearer token on its own, replaced by `[redacted]`.
- `testMcpServer` records `last_*`; a success replaces `tools_snapshot`, a failure keeps it.

## Specs

| Spec | Pins |
| --- | --- |
| `tests/mcp.config.spec.ts` | Name, URL, header and token rules; the secrets patch; the SDK config; stored policy normalisation. |
| `tests/engine.connectors.spec.ts` | `connectorCallVerdict`, policy lookup under the CLI's spelling, `resolveToolGate` across modes, `decideToolCall`, `composeMcpServers`. |
| `tests/engine.connectors-stream.spec.ts` | The same through `runEngineStream` with a scripted SDK: allow runs without a card, block never asks, ask shows the card with its token, unknown servers and mismatched provenance are refused. |
| `tests/engine.external-tools.spec.ts` | The classification with no policy at all. |
| `tests/engine.sdk-notices.spec.ts` | The `system/init` notice. |
| `tests/mcp.probe.spec.ts` | The probe against the hand-written MCP server in `tests/mcp-fixture.ts`, both transports, and the egress guard in front of it. |
| `tests/mcp.server.spec.ts` | The rows against the live database: encryption, validation, edits, audit, the Test bookkeeping, run start. |
| `tests/crud/mcp.crud.spec.ts` | The page on desktop and mobile. |
| `tests/chat.connector-tool-labels.spec.ts`, `tests/costs.tool-call-ledger.spec.ts` | Card labels and the ledger's `mcp:<name>` provider. |
