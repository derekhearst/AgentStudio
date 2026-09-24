# Connectors (MCP)

## Overview

A **connector** lets your chats use the tools of another service — GitHub, an issue tracker, a knowledge base, a home-lab tool — through the Model Context Protocol (MCP). You add the service's MCP server address on **Settings → Connectors** (`/settings/connectors`), test the connection, and decide what each of its tools may do. From the next chat turn, the assistant can call those tools alongside AgentStudio's own.

AgentStudio has always *served* MCP: its own tools reach the Claude engine through an in-process MCP server called `agentstudio`. Connectors are the other direction: AgentStudio *consuming* servers that someone else runs.

Version one covers **remote servers only**, over **Streamable HTTP** or the older **SSE** transport, signing in with a **bearer token** or **custom headers**. Local (stdio) servers and servers that only accept an OAuth sign-in are not supported yet; see [Not supported yet](#not-supported-yet) for why.

[spec.md](spec.md) is the technical reference: the table, the engine options and the checks behind each rule.

## Key concepts

| Concept | What it means |
| --- | --- |
| **Connector** | One MCP server you added: a label, a name, a transport, a URL, and optionally a bearer token and headers. Stored per user in the `mcp_servers` table. |
| **Label** | What the settings page calls it, e.g. "GitHub". Free text, changeable. |
| **Name** | The connector's key, e.g. `github`. Its tools reach the assistant as `mcp__github__<tool>`. Lower-case letters and digits in hyphen-separated runs, at most 32 characters, and fixed once the connector exists — renaming it would rename every tool and split its usage history. |
| **Transport** | **Streamable HTTP** (the current MCP standard, usually at a `/mcp` path) or **SSE** (older servers, usually at `/sse`). |
| **Bearer token** | Sent as `Authorization: Bearer <token>` on every request. A personal access token is the usual example. |
| **Headers** | Up to 20 custom headers, such as `X-Api-Key`, for servers that sign in another way. |
| **Tool list** | What the last successful **Test** found the server offering: each tool's name, description, and the server's own hints about whether it only reads or can destroy data. The hints are shown to help you decide; nothing is decided by them. |
| **Tool policy** | Per tool: **Allow** (runs without asking), **Ask** (asks for your approval every time — the default), or **Block** (refused, and hidden from the assistant). |
| **Enabled** | Whether chats load the connector. Switching it off keeps everything, including the stored token. |
| **Last test** | When the connection was last tested, whether it worked, and the reason if it did not. Changing the URL, transport or credentials clears it. |

## User flows

### Adding a connector

1. On Settings → Connectors, choose **Add connector**.
2. Enter a label. The name fills itself in from the label (for example "GitHub Issues" becomes `github-issues`); change it if you like before saving.
3. Choose the transport and enter the server's URL.
4. Paste a bearer token and/or add headers if the server needs them.
5. Choose **Save**, or **Save and test** to test straight away.

The token and header values are encrypted before they are stored and are never shown again — the page only says which headers are set and whether a token is.

### Testing the connection

**Test** connects to the server, asks for its tools (every page of them), and hangs up. It gives the server 10 seconds. The result is recorded on the connector:

- **Connected** — the tool list is replaced with what the server offers now.
- **Failed** — the reason is shown in plain words ("The server wants credentials (401 Unauthorized)…", "Nothing answered at this URL (404)…", "The host name does not resolve…"), and the previous tool list is kept so its policies stay editable.

### Deciding what each tool may do

Once a test has listed the tools, open **Tools** on the connector card. Each tool has **Allow / Ask / Block**, and **Every tool** sets all of them at once. A tool the server adds later, which no test has seen yet, asks.

### Editing, switching off and removing

- **Edit** changes the label, transport, URL, timeout and credentials. A token or header value left blank keeps what is stored; **Remove** on a header, or **Remove the stored token**, deletes it. Only a real change to the address or credentials clears the last test.
- The **On/Off** switch decides whether chats load the connector.
- **Remove** deletes the connector and its stored credentials after a confirmation.

### What happens in a chat turn

1. When a turn starts, AgentStudio loads your enabled connectors.
2. For each one it checks the URL again and resolves the server's host name under the same rule the Test button uses. A connector whose host now points at a private address, or whose credentials cannot be decrypted, is left out, and the chat shows a note naming it.
3. The rest are handed to the Claude engine beside AgentStudio's own tool server. Tools you blocked are removed from what the assistant sees.
4. If the engine reports that a connector could not connect or needs a sign-in, the chat shows a warning naming it; its tools are simply missing from that turn.
5. Each call to a connector's tool goes through the approval rules below. Its card in the chat reads like "Create Issue in progress · github".
6. Each call is counted in the usage ledger under its full tool name, with the connector recorded as its provider.

Connectors join **interactive chat turns only**, and only for an agent **without a fixed tool list**. Automations, scheduled runs and agents limited to a set of tools never load them: nobody is there to approve a call, and a fixed tool list would refuse the tools anyway.

## Roles and permissions

| Action | Who |
| --- | --- |
| Add, test, edit, switch off, remove a connector; set its tool policies | Its owner (AgentStudio is single-user), on Settings → Connectors |
| Call a connector's tools | The assistant in the owner's interactive chats, under the approval rules below |
| Add or change a connector from a conversation | Nobody. No tool and no API route exposes connectors: a run that could add one could connect a server to itself. |

### Approval rules

How a call to a connector's tool is decided, by the conversation's permission mode:

| Tool policy | Ask (default) | Accept edits | Plan | Bypass |
| --- | --- | --- | --- | --- |
| **Allow** | Runs | Runs | Refused | Runs |
| **Ask** | Asks | Asks | Refused | Runs |
| **Block** | Refused | Refused | Refused | Refused |

- **Plan** refuses every connector tool, allowed or not: AgentStudio cannot tell what a tool does from its name, and plan mode refuses anything that might change something.
- **"Require approval for all tools"** (Settings → Tool Approval) still wins: with it on, an allowed connector tool asks.
- The per-tool ticks on Settings → Tool Approval list AgentStudio's own tools and never apply to a connector's; the connector's own page is where its tools are decided.

## Integrations

| System | How connectors use it |
| --- | --- |
| **Claude Agent SDK** (0.3.278) | Enabled connectors go into the engine's `mcpServers` option beside `agentstudio`. `strictMcpConfig` is always on, so the engine loads **only** the servers AgentStudio passes — never a repository's `.mcp.json`, user or plugin servers, or the claude.ai account's own connectors. Blocked tools go into `disallowedTools`. |
| **MCP TypeScript SDK** (`@modelcontextprotocol/sdk`) | The Test button's own client. The engine's session handle lives for one chat turn, so the settings page cannot use it. |
| **Egress guard** (`$lib/tools/egress*`) | Every request the Test button makes goes through it: public addresses only, checked on the connection actually used; redirects are not followed; responses are capped. Run start resolves each connector's host under the same rule. |
| **Encryption** (`APP_ENCRYPTION_KEY`) | Encrypts each connector's token and header values as one document. Without the key, a connector that needs credentials cannot be saved; one that needs none still can. |
| **Audit log** | Adding, editing, switching and removing a connector, and changing its tool policies, are recorded with header *names* only — never values — and the URL without its query string. |
| **Usage ledger** | Each connector tool call is one zero-cost `call` row under its full tool name, with provider `mcp:<name>`. |

## Business rules

### Names

- Lower-case letters and digits, separated by single hyphens; at most 32 characters. With no underscores, `mcp__<name>__<tool>` splits in exactly one place, and the engine spells the name exactly as saved.
- Reserved: `agentstudio` (ours), the engine's own server names (`workspace`, `ide`, `memory`, `hearthbot`) and anything starting with `claude`.
- Unique per user, and fixed after creation.

### URLs

- `https://` or `http://` only. Plain `http://` is allowed but the form warns that a token would travel unencrypted.
- No `user:password@` in the URL — the URL is stored and shown as typed, so credentials belong in the token or headers. The same goes for a token in the query string.
- The host must be on the public internet by the egress guard's rules: no `localhost`, private ranges, link-local or cloud metadata addresses, and no single-label or `.local` / `.internal` names. The deployment's operator can exempt specific hosts for servers on their own network with `MCP_ALLOWED_PRIVATE_HOSTS` (comma- or space-separated host names or addresses). The exemption covers exactly those hosts.

### Credentials

- At most 20 headers, each value at most 8 KB, with no line breaks.
- Headers the connection itself sets are refused: `Host`, `Content-Length`, `Content-Type`, `Accept`, `Accept-Encoding`, the hop-by-hop headers, `Proxy-Authorization`, `Mcp-Session-Id`, `Mcp-Protocol-Version`, `Last-Event-Id`.
- Use either the bearer token or an `Authorization` header, not both. The token is pasted alone, without "Bearer ".
- An error message a server sends back has any token or header value replaced with `[redacted]` before it is stored or shown.

### Other limits

- Call timeout: optional, 1 second to 10 minutes; blank leaves the engine's default.
- The Test button waits 10 seconds and reads at most 500 tools over at most 20 pages.
- The engine's generic MCP resource readers (`ListMcpResourcesTool`, `ReadMcpResourceTool`, `ReadMcpResourceDirTool`) are turned off on every run: they name the server in an argument, so a connector's policy could not see which one a read went to. AgentStudio's own server publishes no resources.

## Security notes

- **Trust is keyed on the connector's row, never on a name the server chooses.** A call to `mcp__<server>__<tool>` is refused unless `<server>` is one of the connectors this turn loaded, and the engine's own report of where the tool came from agrees (a server passed by AgentStudio, under that key). A call that carries AgentStudio's own server name but comes from anywhere other than AgentStudio's in-process server is refused. If the engine reports nothing about a call's origin, an allowed tool asks instead of running.
- **Credentials reach the engine process as a command-line argument**, because that is how the Agent SDK hands servers to the CLI. In production the agent's shell runs in a sandbox with its own process table, so it cannot read another process's arguments; on a host without the sandbox, every shell command already asks for approval. Credentials are never put in the engine's environment, which the shell inherits.
- **Run start narrows, but does not close, the DNS window.** The engine connects to a connector itself, outside the egress guard. AgentStudio resolves each host just before handing it over and leaves out any that resolves privately, but the engine resolves the name again when it connects.

## Not supported yet

- **Local (stdio) servers.** A stdio server is a program the engine starts. It would run outside the shell sandbox, as the container user, with the engine's own login token in its environment — a much larger grant than a remote server. The production image also has no Node or Python toolchain for the usual `npx` / `uvx` servers. This needs its own decision.
- **OAuth-only servers.** The Agent SDK gives hosts no control over an MCP OAuth sign-in, so this needs AgentStudio to run the discovery, client registration and token refresh itself. Servers that accept a personal access token (GitHub's remote MCP server, for example) work today with the bearer token.
- **Per-agent connectors.** Every unscoped chat gets every enabled connector.
- **Live status.** The page shows the last test, not whether the engine is connected right now; a turn whose connector failed says so in the chat.
- **Approval cards inside a subagent.** A connector tool called by a delegated agent asks in the approval dock rather than on an inline card.

## What was checked in the SDK

Verified against `@anthropic-ai/claude-agent-sdk` 0.3.278 (`sdk.d.ts`, `sdk.mjs` and the bundled CLI):

- `Options.mcpServers` accepts `{ type: 'http' | 'sse', url, headers?, timeout? }`; a `timeout` under 1000 ms is ignored. `alwaysLoad` would block the turn's start until the server connects, so it is never set.
- `strictMcpConfig: true` becomes `--strict-mcp-config`, which ignores every MCP configuration except the servers passed in `mcpServers`; the bundled CLI's own message confirms that claude.ai connectors are not loaded when MCP servers are restricted to explicitly passed config.
- Process-transport servers reach the CLI as `--mcp-config <json>` on its command line.
- `canUseTool` receives `mcpServer: { name, source }` and the `PreToolUse` hook receives `mcp_server` for MCP tools. `source` is `sdk` only for an in-process server the host registered, `dynamic` for a server passed through `mcpServers`; the typings say to key trust on `source` and to treat unknown values as configured, never as `sdk`.
- `system/init` lists `mcp_servers` with `name`, `status` (`connected`, `failed`, `needs-auth`, `pending`, `disabled`) and `source`. MCP start-up does not block the turn, so `pending` is not treated as a failure.
- The CLI builds a tool's name as `mcp__<server>__<tool>`, rewriting any character outside `[a-zA-Z0-9_-]` in either part to `_`, and splits a name on `__`. Tool policies are matched under that spelling.
- `McpServerToolPolicy` (`always_allow` / `always_ask` / `always_deny` on a server's config) exists but is documented only for `mcp_set_servers`; AgentStudio does not use it, so there is no second allow path outside its own gate.
