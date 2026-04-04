# DrokBot: Integrate Built-in Sandbox Capabilities

## Context

DrokBot is a self-hosted autonomous AI agent platform built with SvelteKit (Svelte 5) + Bun + TypeScript + TailwindCSS v4 + DaisyUI. It currently depends on an external sandbox container at `SANDBOX_URL` (the `@agent-infra/sandbox` AIO Sandbox) for shell execution, file operations, and browser automation. We're replacing that external dependency by building sandbox capabilities directly into the DrokBot container.

The repo is at: https://github.com/derekhearst/DrokBot

## What's Already Done

Three files have been drafted and need to be integrated into the project:

### 1. `src/lib/server/sandbox.ts` — Sandbox Module

A server-side utility module that provides:
- **Shell**: `shellExec(command, opts)` — runs bash commands in `/workspace`, returns `{ exitCode, stdout, stderr }`
- **Files**: `fileRead(path)`, `fileWrite(path, content)`, `fileDelete(path)`, `fileList(path)` — all path-safe within `SANDBOX_WORKSPACE`
- **Git**: `gitClone`, `gitStatus`, `gitCommit`, `gitPush`, `gitDiff` — convenience wrappers over shell
- **Browser**: `browserNavigate(url)`, `browserScreenshot()`, `browserClick(selector)`, `browserType(selector, text)`, `browserGetText(selector?)`, `browserGetHtml(selector?)`, `browserEvaluate(script)`, `browserClose()` — Playwright-backed, lazy-launched headless Chromium

All file/shell operations are sandboxed to the `SANDBOX_WORKSPACE` env var (defaults to `/workspace`).

### 2. `Dockerfile` — Updated Build

Multi-stage build on `oven/bun:1` that adds:
- System Chromium + font/rendering deps
- Git, curl, wget
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium` (uses system browser)
- `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`
- `/workspace` volume for agent file ops

### 3. `docker-compose.yml` — TrueNAS Deployment

- Mounts `/mnt/Apps/Apps/drokbot/workspace:/workspace`
- Sets `seccomp:unconfined` + `shm_size: 1gb` for Chromium
- Removes the `SANDBOX_URL` dependency
- Sets `SANDBOX_WORKSPACE=/workspace`

## Your Tasks

### Task 1: Add Playwright Dependency

```bash
bun add playwright
```

Note: We only need the `playwright` package (not `@playwright/test`). The Dockerfile installs system Chromium, so Playwright's browser download is skipped via env vars.

### Task 2: Integrate `sandbox.ts` into the Project

Place the provided `src/lib/server/sandbox.ts` file in the project. Review it and adjust to match existing code conventions (import style, error handling patterns, etc.).

### Task 3: Refactor Existing Sandbox/Tool Calls

Find all existing code that calls the external `SANDBOX_URL` — this includes any HTTP client calls to the AIO Sandbox API for:
- Shell/command execution
- File read/write
- Browser navigation, screenshots, clicking, scraping

Replace those HTTP calls with direct imports from `$lib/server/sandbox`:

```typescript
// Before (external HTTP call)
const result = await fetch(`${SANDBOX_URL}/api/shell/exec`, {
  method: 'POST',
  body: JSON.stringify({ command: 'ls -la' })
});

// After (local function call)
import { shellExec } from '$lib/server/sandbox';
const result = await shellExec('ls -la');
```

Do the same for file operations and browser automation. The new API is:

| Old (external) | New (local import) |
|---|---|
| Shell exec | `shellExec(command, { cwd?, timeout?, env? })` |
| File read | `fileRead(path)` |
| File write | `fileWrite(path, content)` |
| File delete | `fileDelete(path)` |
| File list | `fileList(path?)` |
| Git clone | `gitClone(repoUrl, dir?)` |
| Git status | `gitStatus(repoDir)` |
| Git commit | `gitCommit(repoDir, message)` |
| Git push | `gitPush(repoDir, remote?, branch?)` |
| Git diff | `gitDiff(repoDir)` |
| Browser navigate | `browserNavigate(url)` → `{ title, url }` |
| Browser screenshot | `browserScreenshot()` → `Buffer` |
| Browser click | `browserClick(selector)` |
| Browser type text | `browserType(selector, text)` |
| Browser get text | `browserGetText(selector?)` |
| Browser get HTML | `browserGetHtml(selector?)` |
| Browser evaluate JS | `browserEvaluate(script)` |
| Browser close | `browserClose()` |

### Task 4: Update Tool Definitions

If tools are defined as schemas/configs (for the OpenRouter LLM to call), make sure the tool definitions still match the new implementation. The tool interface the LLM sees shouldn't need to change — only the backend handler that executes the tool.

### Task 5: Remove `SANDBOX_URL` References

- Remove `SANDBOX_URL` from `.env.example`
- Remove any sandbox health checks or connection logic that pings the external sandbox
- Remove any `@agent-infra/sandbox` SDK imports/dependencies if present
- Clean up any sandbox client initialization code

### Task 6: Update the Dockerfile

Replace the existing Dockerfile (if any) with the provided one. Key points:
- Multi-stage build: `base` → `deps` → `build` → `production`
- System Chromium via apt, NOT Playwright's bundled download
- Git pre-configured with DrokBot identity
- `/workspace` volume for persistent agent work
- Runs as `bun` user

If there's an existing Dockerfile, preserve any project-specific customizations that aren't covered by the new one.

### Task 7: Update `docker-compose.yml`

Replace or update the compose file with the provided one. Ensure:
- `SANDBOX_URL` env var is removed
- `SANDBOX_WORKSPACE=/workspace` is set
- `seccomp:unconfined` and `shm_size: 1gb` are present (required for Chromium)
- Workspace volume mount: `/mnt/Apps/Apps/drokbot/workspace:/workspace`

### Task 8: Test

1. **Shell**: Execute a basic command and verify stdout is returned
2. **Files**: Write a file to workspace, read it back, list the directory, delete it
3. **Git**: Clone a small public repo, check status, make a commit
4. **Browser**: Navigate to a URL, take a screenshot, extract text from the page
5. **Integration**: Run the full app and trigger a tool call through the chat UI that exercises the sandbox

## Architecture Notes

- `sandbox.ts` is server-only (`$lib/server/` path ensures SvelteKit won't bundle it for the client)
- The browser instance is lazy-launched and reused across calls for performance. `browserClose()` should be called between unrelated tasks or on shutdown.
- All file paths are resolved against `SANDBOX_WORKSPACE` with an escape check — any path that resolves outside the workspace throws an error
- Shell commands run as the `bun` user inside the container. The workspace volume should be owned by UID/GID 1000 (bun's default) on the TrueNAS host.
- No auth layer on the sandbox functions since they're internal imports, not HTTP endpoints. The app's existing `AUTH_PASSWORD` gate protects the chat UI.

## Do NOT

- Do NOT add a separate HTTP API server for the sandbox. These are local function calls, not a microservice.
- Do NOT install `@playwright/test` — we only need the `playwright` core library.
- Do NOT download Playwright browsers at build time — the Dockerfile installs system Chromium.
- Do NOT remove the SearXNG integration — that's a separate search tool, not part of the sandbox replacement.
