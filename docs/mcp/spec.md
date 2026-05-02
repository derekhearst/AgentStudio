# MCP Spec

## Overview

AgentStudio integrates third-party tools via the Model Context Protocol (MCP). Any MCP server — a local stdio process or a remote SSE/HTTP endpoint — can be registered, connection-tested, and made available to agents. MCP tools surface through the same capability group and approval system as first-party tools; there is no special call path for MCP.

## Data Model

### `mcpServers` table

| Column       | Type      | Description                                                                 |
| ------------ | --------- | --------------------------------------------------------------------------- |
| `id`         | uuid      | Primary key                                                                 |
| `userId`     | uuid?     | FK to `users` — owner; null = system-wide (admin-created, available to all) |
| `name`       | text      | Display name (e.g., "GitHub", "Linear", "Filesystem Bridge")                |
| `slug`       | text      | Unique per user, URL-safe — used to name the capability group `mcp/<slug>`  |
| `transport`  | enum      | `stdio`, `sse`, `http`                                                      |
| `command`    | text?     | `stdio` only: executable path                                               |
| `args`       | jsonb?    | `stdio` only: argument array                                                |
| `url`        | text?     | `sse` / `http` only: endpoint URL                                           |
| `authMode`   | enum      | `none`, `bearer`, `header`, `oauth`                                         |
| `authConfig` | jsonb?    | Encrypted credentials (token, header name/value, OAuth config)              |
| `isActive`   | boolean   | When false, server is excluded from all capability groups                   |
| `createdAt`  | timestamp |                                                                             |
| `updatedAt`  | timestamp |                                                                             |

### `mcpServerTools` table

Discovered tools from a registered MCP server. Refreshed on registration and on demand.

| Column        | Type      | Description                           |
| ------------- | --------- | ------------------------------------- |
| `id`          | uuid      | Primary key                           |
| `mcpServerId` | uuid      | FK to `mcpServers`                    |
| `name`        | text      | Tool name as returned by `list_tools` |
| `description` | text      | Tool description                      |
| `inputSchema` | jsonb     | JSON Schema for tool parameters       |
| `refreshedAt` | timestamp | When this record was last discovered  |

### `mcpServerAssignments` table

Controls which agents have access to which MCP servers.

| Column        | Type      | Description                                                               |
| ------------- | --------- | ------------------------------------------------------------------------- |
| `id`          | uuid      | Primary key                                                               |
| `mcpServerId` | uuid      | FK to `mcpServers`                                                        |
| `agentId`     | uuid?     | FK to `agents`; null = available to all agents owned by the server's user |
| `createdAt`   | timestamp |                                                                           |

---

## Features

### Transport modes

**stdio** — the runtime spawns the server as a child process using the configured `command` and `args`. Communication is via stdin/stdout using MCP JSON-RPC. The process lifetime is scoped to the run; it is killed when the run ends or errors. Used for local tools: filesystem bridges, local database clients, CLI wrappers.

**SSE** — the runtime opens a persistent Server-Sent Events connection to the configured URL. Used for hosted services that implement the MCP SSE transport (e.g., self-hosted MCP gateways).

**HTTP** — the runtime makes individual HTTP requests per tool call using the MCP Streamable HTTP transport. Used for stateless remote MCP services.

### One capability group per server

Each active MCP server creates a dynamic capability group named `mcp/<slug>`. This group behaves identically to first-party groups:

- It is **not** `alwaysOn` by default.
- The model enables it via `enable_capability('mcp/github')`.
- Enabling injects the server's tool descriptions into the active tool set.
- A companion skill can be associated with the server (stored in `skills` with slug `mcp/<slug>`) to guide the model on when and how to use the server's tools.

This preserves the progressive disclosure model regardless of how many MCP servers are registered.

### Tool naming and namespacing

MCP tool names are prefixed as `<serverSlug>__<toolName>` in the active tool set. Double underscore is used because MCP tool names may contain slashes, and the prefix must be unambiguous. For example: `github__create_issue`, `linear__create_issue`. The model calls the prefixed name; the runtime strips the prefix before forwarding to the MCP server.

### Tool discovery

When a server is registered (or on admin demand from the management UI), the runtime:

1. Opens a connection to the server.
2. Calls `list_tools`.
3. Upserts `mcpServerTools` rows (matched by `mcpServerId` + `name`).
4. Marks stale tool rows (present in DB but not returned by `list_tools`) as soft-deleted.

Discovery results are shown in the server detail UI. Tools refreshed more than 7 days ago are flagged as potentially stale.

### Approval policy

MCP tool calls flow through the same approval system as first-party tools. Default approval rules:

- Tools whose `name` contains `write`, `create`, `update`, `delete`, `push`, `send`, or `post` require approval.
- All other MCP tools are auto-approved.

Users can override per-tool approval requirements from the server detail page or from `/settings/mcp`.

### Tool output context policy

MCP tool outputs are subject to the same size-capped context policy as first-party tools. Outputs larger than 4,000 tokens are archived; the model receives a summary + pointer handle and can call `read_output(handle, offset, length)` for more.

---

## Security

### stdio servers

- `command` is validated against an allowlist of permitted executable paths (configurable; default: deny absolute paths outside designated tool directories and deny shell interpreters).
- `args` are passed as an array and are not shell-expanded — no injection via argument content.
- The subprocess environment is sanitized: app secrets and database credentials are not inherited.
- Processes are run with a restricted working directory scoped to the run's workspace.

### Remote servers

- Auth tokens and header values in `authConfig` are encrypted at rest (AES-256-GCM) using a key from `MCP_SECRET_KEY` env var.
- Plaintext credentials are never logged, never included in run events, and never returned to the client after save.
- TLS verification is enforced for all remote connections (no `rejectUnauthorized: false`).

---

## Management UI

`/settings/mcp` — list of registered servers with transport badge, active status, tool count, and last discovery timestamp.

`/settings/mcp/new` — register a new server. Form adapts to transport type: stdio shows command/args fields; SSE/HTTP shows URL and auth fields.

`/settings/mcp/[id]` — server detail:

- Discovered tools list with per-tool approval override
- Agent assignment list
- Test connection button (runs `list_tools` and shows results or error)
- Re-discover tools button
- Companion skill link (edit or create a `mcp/<slug>` skill)

System-wide servers (created by admin with `userId = null`) appear for all users but can only be edited by admins.

---

## Behavior Contracts

- A server with `isActive = false` does not appear in any agent's capability groups, even if assigned.
- Discovery failure (connection refused, auth error, timeout) does not fail a run. The server's capability group is unavailable for that run; the runtime emits a `hook_failure`-level warning event.
- If an assigned server cannot connect at run start, it is silently skipped — the agent can still run without it.
- `mcpServerTools` rows are never hard-deleted; stale rows are soft-deleted and excluded from the capability group but preserved for audit.
- System-wide servers are available to all users' agents; user-scoped servers are only available to the owning user's agents.
- Slugs are unique per user and immutable after creation.

## References

- [Model Context Protocol specification](https://spec.modelcontextprotocol.io/)
- [MCP Transports — stdio, SSE, HTTP](https://spec.modelcontextprotocol.io/specification/architecture/transports/)
- **Internal:** `src/lib/mcp/`, `src/routes/settings/mcp/`
