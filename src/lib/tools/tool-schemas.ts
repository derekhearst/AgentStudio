import { z } from 'zod'
// Relative rather than `$lib/...` on purpose: this module is imported directly by specs
// running in the plain Playwright/Node loader, where the SvelteKit alias is not guaranteed
// to resolve. `monitors/condition` is dependency-light (zod only) for the same reason.
import {
	monitorActionConfigSchema,
	monitorActionSchema,
	monitorConditionSchema,
	MONITOR_HARD_MAX_CHECKS,
	MONITOR_MAX_DEADLINE_DAYS,
	MONITOR_MAX_INTERVAL_SECONDS,
	MONITOR_MIN_INTERVAL_SECONDS,
	MONITOR_OBSERVABLE_TOOLS,
} from '../monitors/condition'

/**
 * Declarative tool surface — Zod input schemas + human-readable descriptions for every
 * tool the assistant can invoke. Kept here (rather than alongside `executeTool`) because
 * other modules (the runtime loop, settings UI, capability classifier) need the schema
 * shape without dragging in the entire 2000-line executor.
 */

export const toolSchemas = {
	web_search: z.object({ query: z.string().min(1) }),
	delete_file: z.object({ path: z.string().min(1), recursive: z.boolean().default(false) }),
	move_file: z.object({
		fromPath: z.string().min(1),
		toPath: z.string().min(1),
		overwrite: z.boolean().default(false),
	}),
	file_info: z.object({ path: z.string().min(1) }),
	// Required: every screenshot loads its page in a fresh browser context, so there is no
	// "current page" to capture without one.
	browser_screenshot: z.object({ url: z.string().url().max(2048) }),
	web_fetch: z.object({
		url: z.string().min(1).max(2048),
		maxChars: z.number().int().min(1000).max(100_000).default(50_000).optional(),
	}),
	pdf_read: z.object({
		// HTTP(S) URL to download + parse, OR an absolute path to a file the agent already
		// wrote into its sandbox workspace (file_write produces these). Validated against the
		// same private-IP/loopback rejection as web_fetch.
		source: z.string().min(1).max(2048),
		maxChars: z.number().int().min(1000).max(200_000).default(100_000).optional(),
	}),
	// Wave 4 #15 phase 2 — Projects agent tools.
	list_projects: z.object({}),
	create_project: z.object({
		name: z.string().trim().min(1).max(120),
		kind: z.enum(['efoil', 'research', 'code', 'documentation', 'other']).optional(),
		description: z.string().trim().max(1000).optional(),
	}),
	// Mandatory-approval handoff: the planner asks the user to approve a plan file and
	// switch the conversation to the implementer agent. On approve, the conversation's bound
	// agent flips so the next round runs as the implementer.
	request_plan_approval: z.object({
		path: z.string().trim().min(1),
		implementerAgentId: z.string().uuid(),
		rationale: z.string().trim().max(1000).optional(),
	}),
	// Wave 4 #15 phase 2 finish — bind a project to the current conversation so subsequent
	// edits target the right project by default. Pass projectId=null (or omit) to unbind.
	set_project_context: z.object({
		projectId: z.string().uuid().nullable().optional(),
	}),
	// Wave 5 #19 phase 3 — source-control agent tools.
	list_my_repos: z.object({
		search: z.string().trim().min(1).max(200).optional(),
		limit: z.number().int().min(1).max(200).optional(),
	}),
	sync_my_repos: z.object({
		includeForks: z.boolean().optional(),
		includeArchived: z.boolean().optional(),
		maxPages: z.number().int().min(1).max(10).optional(),
	}),
	prepare_commit: z.object({
		path: z.string().trim().min(1).max(1024).optional(),
	}),
	push_branch: z.object({
		path: z.string().trim().min(1).max(1024).optional(),
		owner: z.string().trim().min(1).max(200),
		repo: z.string().trim().min(1).max(200),
		branch: z.string().trim().min(1).max(200).optional(),
		force: z.boolean().optional(),
	}),
	create_pull_request: z.object({
		owner: z.string().trim().min(1).max(200),
		repo: z.string().trim().min(1).max(200),
		title: z.string().trim().min(1).max(256),
		body: z.string().max(20_000).optional(),
		head: z.string().trim().min(1).max(200),
		base: z.string().trim().min(1).max(200),
		draft: z.boolean().optional(),
	}),
	list_pull_requests: z.object({
		owner: z.string().trim().min(1).max(200),
		repo: z.string().trim().min(1).max(200),
		limit: z.number().int().min(1).max(100).optional(),
	}),
	get_pull_request: z.object({
		pullRequestId: z.string().uuid(),
	}),
	clone_repository: z.object({
		owner: z.string().trim().min(1).max(200),
		repo: z.string().trim().min(1).max(200),
	}),
	run_subagent: z.object({
		task: z.string().min(1),
		context: z.string().optional(),
		agentId: z.string().uuid().optional(),
	}),
	image_generate: z.object({
		prompt: z.string().min(1).max(2000),
		model: z.enum(['flux', 'sdxl', 'dall-e']).default('flux'),
		size: z.enum(['256x256', '512x512', '1024x1024']).default('1024x1024'),
	}),
	video_generate: z.object({
		prompt: z.string().min(1).max(2000),
		/** OpenRouter video model id, e.g. `google/veo-3.1`, `alibaba/wan-2.7`. */
		model: z.string().min(1).max(120),
		resolution: z.enum(['480p', '720p', '1080p', '4k']).default('720p'),
		aspectRatio: z.enum(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']).default('16:9'),
		durationSeconds: z.number().min(1).max(60).default(5),
		seed: z.number().int().optional(),
		generateAudio: z.boolean().optional(),
		/** Cap on poll-wait time before returning a still-pending job. */
		timeoutSeconds: z.number().int().min(30).max(600).default(300),
	}),
	list_agents: z.object({}),
	update_agent: z.object({
		agentId: z.string().uuid(),
		name: z.string().min(1).max(120).optional(),
		role: z.string().min(1).max(240).optional(),
		systemPrompt: z.string().min(1).optional(),
		model: z.string().min(1).max(120).optional(),
	}),
	pause_agent: z.object({
		agentId: z.string().uuid(),
	}),
	resume_agent: z.object({
		agentId: z.string().uuid(),
	}),
	create_automation: z.object({
		agentId: z.string().uuid().nullable().optional(),
		description: z.string().min(1).max(200),
		cronExpression: z.string().min(1).max(120),
		prompt: z.string().min(1),
		enabled: z.boolean().default(true),
		conversationMode: z.enum(['new_each_run', 'reuse']).default('new_each_run'),
	}),
	list_automations: z.object({}),
	update_automation: z.object({
		automationId: z.string().uuid(),
		agentId: z.string().uuid().nullable().optional(),
		description: z.string().min(1).max(200).optional(),
		cronExpression: z.string().min(1).max(120).optional(),
		prompt: z.string().min(1).optional(),
		enabled: z.boolean().optional(),
		conversationMode: z.enum(['new_each_run', 'reuse']).optional(),
	}),
	delete_automation: z.object({
		automationId: z.string().uuid(),
	}),
	// #33 — long-horizon monitors. An automation runs on a clock; a monitor watches for a
	// condition and acts when it changes. Every one of them expires.
	create_monitor: z.object({
		name: z.string().trim().min(1).max(200),
		condition: monitorConditionSchema,
		action: monitorActionSchema,
		actionConfig: monitorActionConfigSchema.optional(),
		intervalSeconds: z
			.number()
			.int()
			.min(MONITOR_MIN_INTERVAL_SECONDS)
			.max(MONITOR_MAX_INTERVAL_SECONDS)
			.optional(),
		deadlineDays: z.number().min(0.01).max(MONITOR_MAX_DEADLINE_DAYS).optional(),
		maxChecks: z.number().int().min(1).max(MONITOR_HARD_MAX_CHECKS).optional(),
		oneShot: z.boolean().optional(),
	}),
	list_monitors: z.object({
		openOnly: z.boolean().optional(),
	}),
	cancel_monitor: z.object({
		monitorId: z.string().uuid(),
	}),
	extend_monitor: z.object({
		monitorId: z.string().uuid(),
		additionalDays: z.number().min(0).max(MONITOR_MAX_DEADLINE_DAYS).optional(),
		additionalChecks: z.number().int().min(0).max(MONITOR_HARD_MAX_CHECKS).optional(),
	}),
	list_skills: z.object({}),
	read_skill: z.object({ name: z.string().min(1) }),
	read_skill_file: z.object({ skillName: z.string().min(1), fileName: z.string().min(1) }),
	create_skill: z.object({
		name: z.string().min(1).max(100),
		description: z.string().min(1).max(500),
		content: z.string().min(1),
		tags: z.array(z.string()).optional(),
	}),
	update_skill: z.object({
		name: z.string().min(1),
		description: z.string().min(1).max(500).optional(),
		content: z.string().min(1).optional(),
		tags: z.array(z.string()).optional(),
	}),
	add_skill_file: z.object({
		skillName: z.string().min(1),
		fileName: z.string().min(1).max(200),
		description: z.string().max(500).default(''),
		content: z.string().min(1),
	}),
	update_skill_file: z.object({
		skillName: z.string().min(1),
		fileName: z.string().min(1),
		content: z.string().min(1).optional(),
		description: z.string().max(500).optional(),
	}),
	delete_skill: z.object({ name: z.string().min(1) }),
	delete_skill_file: z.object({ skillName: z.string().min(1), fileName: z.string().min(1) }),
	git_status: z.object({}),
	git_log: z.object({
		max: z.number().int().min(1).max(200).default(20),
		paths: z.array(z.string().min(1)).optional(),
	}),
	git_diff: z.object({
		ref: z.string().min(1).optional(),
		paths: z.array(z.string().min(1)).optional(),
		staged: z.boolean().default(false),
	}),
}

export type ToolName = keyof typeof toolSchemas

export const allToolNames = Object.keys(toolSchemas) as ToolName[]

/**
 * Normalize a tool name from the model: trim, then case-insensitive snake_case match against the
 * registry. Returns null when no canonical match exists. Used by `executeTool`, so a call
 * spelled `Web_Search` or `web-search` resolves to the canonical `web_search`.
 */
export function normalizeToolName(name: string): ToolName | null {
	const trimmed = name.trim()
	if (trimmed in toolSchemas) return trimmed as ToolName
	const normalized = trimmed.toLowerCase().replace(/[\s-]+/g, '_')
	if (normalized in toolSchemas) return normalized as ToolName
	return null
}

export const toolDescriptions: Record<ToolName, string> = {
	web_search: 'Search the web for information.',
	delete_file: 'Delete a file or directory (recursive deletes require explicit recursive=true).',
	move_file: 'Move or rename a file/directory within the sandbox workspace.',
	file_info: 'Get file or directory metadata (size, modified time, permissions).',
	browser_screenshot: 'Take a screenshot of a web page (HTTP/HTTPS only; private and loopback addresses are blocked). Returns the image so you can see the rendered page.',
	web_fetch: 'Fetch the full text content of a web page (HTTP/HTTPS only). Returns { title, url, text, fetchedAt } with the body text trimmed to maxChars (default 50,000). Blocks private/loopback addresses to prevent SSRF. Use this when web_search snippets are insufficient and you need to read the actual page content.',
	pdf_read: 'Extract text from a PDF — accepts an HTTP/HTTPS URL OR an absolute path to a PDF the agent has already written into its sandbox workspace. Uses pdftotext (poppler-utils) under the hood; returns { source, text, charCount, truncated, pageHint }. Same SSRF protection as web_fetch for URLs. Use this for whitepapers, datasheets, regulatory filings, or research-attached PDFs that web_fetch can\'t parse.',
	list_projects: 'List the user\'s projects (durable work surfaces, each with its own sandbox working directory). Returns id, name, slug, kind, description for each project.',
	create_project: 'Create a new project to group related work. Slug auto-generated from name + deduped per-user. Kinds: efoil/research/code/documentation/other.',
	list_my_repos: 'List source-control repositories the user has imported (downloaded) into AgentStudio. Optional `search` substring on owner/name. Returns id, owner, name, defaultBranch, htmlUrl, private. New imports are managed at /projects (each imported project has a sidecar repository row); only imported (locally cloned) repos are visible here. Prefer `list_projects` for the canonical list of work surfaces.',
	sync_my_repos: 'Sync the user\'s GitHub repos into AgentStudio (idempotent). Requires the user to have connected GitHub at /projects (Connections panel). Returns {total, inserted, updated, skipped} or an errorMessage when the connection is missing/expired. Prefer the picker on /projects for human-driven imports.',
	prepare_commit: 'Inspect a working tree (defaults to the workspace root; supply a relative `path` to inspect a subdirectory) and produce a structured commit draft. Returns {branch, upstream, ahead, behind, dirty, diff: {filesChanged, insertions, deletions, files}, suggestedSubject, files}. Read-only — no commit/push happens. Use as the first step before requesting human approval to push or open a PR. The path must be a git repository (has a .git entry); otherwise the call fails with a clear error.',
	push_branch: 'Push a local branch to GitHub. ALWAYS REQUIRES OPERATOR APPROVAL — mandatory regardless of per-tool settings, refused entirely in detached/automation runs. Authenticates with the user\'s connected GitHub OAuth token (no SSH keys). Pushes to `https://github.com/<owner>/<repo>.git` so the local `origin` remote is irrelevant; `branch` defaults to the current HEAD if omitted. `force=true` enables `--force-with-lease` (safer than plain --force): rejected if the remote branch moved since AgentStudio last fetched or pushed it, so run clone_repository (or Pull latest on the project) first when someone else may have pushed. Returns {success, branch, remote, stdout, stderr, exitCode} with the token redacted from any output.',
	create_pull_request: 'Open a pull request on GitHub against an attached repository. ALWAYS REQUIRES OPERATOR APPROVAL — mandatory regardless of per-tool settings, refused entirely in detached/automation runs. `head` is the source branch (or `owner:branch` for cross-fork PRs); `base` is the target branch (typically the repo default). `draft=true` opens a draft PR (the default). Persists the resulting PR row to the source-control schema linked to the active run, and opens a `pull_request_ready` review-inbox item so an operator can spot the new PR in /review. Returns {number, htmlUrl, state, draft, recordedId}.',
	list_pull_requests: 'List pull requests recorded for a repository (the user must have synced the repo via sync_my_repos first). Returns up to `limit` rows (default 50) ordered by most recently updated, each with {id, providerPrNumber, title, status, headBranch, baseBranch, providerUrl, runId, taskId, createdBy, createdAt, updatedAt}. Read-only. Returns an empty list when the repo has no recorded PRs yet.',
	get_pull_request: 'Fetch a single pull request by its AgentStudio id (the `recordedId` returned by create_pull_request, or any id from list_pull_requests). Returns the full row including title, body, status, head/base branches, providerUrl, runId, taskId, metadata. Read-only. Returns null when the id is unknown.',
	clone_repository: 'Materialize a local clone of a connected GitHub repo under the per-user sandbox (`${SANDBOX_WORKSPACE}/<userId>/repos/<owner>/<repo>`, legacy layout). Idempotent — if the path already has a clone, refreshes it instead: every remote branch is fetched into origin/*, and the checked-out branch is fast-forwarded when it is behind (the `refresh` field of the result says if it was left alone, e.g. because of local changes). Authenticated via the user\'s stored OAuth token (private repos work without the agent ever seeing the token). Returns {path, fresh, branch}. Prefer creating an imported project at /projects: that flow clones into the project\'s sandbox path and gives you the full repo controls UI; this tool is kept for ad-hoc one-shot clones outside any project.',
	set_project_context: 'Bind a project to the current conversation so subsequent agent edits know which project to target by default. Pass projectId=null (or omit) to unbind. The bound project shows up in the conversation\'s system-prompt context slot so the agent has continuous awareness of which project is "in scope".',
	run_subagent:
		'Run a subagent to handle a task. Optionally specify agentId to delegate to a specific agent. Without agentId, uses a general-purpose stateless subagent.',
	image_generate: 'Generate an image from a text prompt.',
	video_generate:
		'Generate a video from a text prompt via async OpenRouter video generation (Veo, Wan, etc.). Submits a job and waits up to `timeoutSeconds` for completion. Returns the job id, status, and (when ready) URLs to download. If the job is still in progress when the timeout hits, the response includes a poll URL the agent can call later.',
	list_agents:
		'List every agent with the full id the other agent tools take: id, name, role, kind, builtinKey (chat, research, plan or autonomous for the built-ins, listed first; null for agents the user created) and availability (available or paused). Read-only. Use it to find the implementerAgentId for request_plan_approval, or the agentId for update_agent, pause_agent and resume_agent.',
	update_agent: 'Update an existing agent fields such as name, role, model, or system prompt.',
	pause_agent:
		'Pause a user-created agent: it is no longer offered for delegation, and automations and monitors that use it are skipped. Direct chats with it still work. Built-in and evaluator agents cannot be paused.',
	resume_agent: 'Resume a paused agent, so it is offered for delegation and its automations and monitors run again.',
	create_automation: 'Create a recurring automation that triggers an agent prompt on a cron schedule.',
	list_automations: 'List automations for the current user.',
	update_automation: 'Update an existing automation schedule, prompt, mode, or enabled state.',
	delete_automation: 'Delete an automation by id.',
	create_monitor:
		'Watch for something to happen and act when it does — the "wake me when X changes" counterpart to create_automation\'s "run this every N". Two condition kinds. `{kind:"tool_result", tool, args, extract, compare}` runs a read-only tool on each check and compares the result: compare="changed" fires when the value differs from the last observation (the FIRST check only records a baseline, it never fires), and equals/contains/matches/not_empty test the value directly. Use `extract` (a dotted path like "text" or "0.status") to narrow the result — comparing a whole web_fetch result is useless because it carries a timestamp that changes every check. `{kind:"model_question", question, context}` fetches context with read-only tools and asks a cheap model a yes/no question about it; use it only when no deterministic comparison will do, because it costs tokens on every check and is subject to the budget gate. Observable tools are read-only: ' +
		MONITOR_OBSERVABLE_TOOLS.join(', ') +
		'. Read/Grep/Glob take the same arguments you would pass them (Read {file_path, offset?, limit?}; Grep {pattern, path?, glob?, output_mode?, "-i"?, head_limit?}; Glob {pattern, path?}) with paths relative to the user\'s sandbox root, so a project file is "projects/<projectId>/<file>"; Read yields the file text itself, so compare it without an extract. `action` is what happens on the firing edge: start_conversation (needs actionConfig.prompt — opens a conversation seeded with that prompt plus what was observed and runs the agent), review_item, push, or run_automation (needs actionConfig.automationId). Firing is debounced to one action per false→true transition, and `oneShot` (default true) retires the monitor after the first. EVERY monitor expires: `deadlineDays` is capped at 30 and defaults to the cap, `maxChecks` caps total spend (default 200), and whichever runs out first ends it. Say what you created and when it will expire.',
	list_monitors:
		'List the current user\'s monitors with what each one is watching, its status (active/paused/fired/expired/exhausted/failed/canceled), the last observed value, when it was last checked and when it next will be, how much of its check budget is spent, and its deadline. Pass openOnly=true for just the active and paused ones. Read-only.',
	cancel_monitor: 'Cancel a monitor by id. Terminal — it stops being checked immediately and cannot be resumed; create a new one instead.',
	extend_monitor:
		'Push a monitor\'s deadline out and/or top up its check budget. Extension is deliberately explicit — monitors expire on purpose. `additionalDays` is measured from NOW and re-capped at 30 days, so repeated extensions cannot compound into an immortal monitor; `additionalChecks` is added to the existing budget and re-capped. A monitor that expired or exhausted its budget becomes active again if the extension leaves it with both time and budget. A canceled monitor cannot be extended.',
	list_skills:
		'List all available skills with their names, descriptions, and nested file names. Use this to discover what skills are available.',
	read_skill:
		'Read a skill by name. Returns the main content and a list of available nested files. Use this when a skill is relevant to the current task.',
	read_skill_file: 'Read a specific nested file within a skill. Use after read_skill to load additional context files.',
	create_skill:
		'Create a new skill with a name, description, and main content. Skills are reusable instruction/knowledge bundles. Keep main content under 8KB.',
	update_skill: 'Update an existing skill by name. Can modify description, content, or tags.',
	add_skill_file:
		'Add a nested file to an existing skill. Files provide optional additional context (e.g., examples, sub-topics).',
	update_skill_file: 'Update a nested file within a skill by skill name and file name.',
	delete_skill: 'Delete a skill and all its nested files by name.',
	delete_skill_file: 'Delete a specific nested file from a skill.',
	git_status:
		'Show the working tree status (`git status --porcelain=v1`). Read-only; only available when the workspace is a git worktree (Phase 4 of #7). Returns the list of changed/untracked files.',
	git_log:
		'Show recent commits with subject, author, and date (read-only). Optional `paths` filter scopes the log to specific files. Only available in worktree mode.',
	git_diff:
		'Show diff between the working tree and `ref` (default: HEAD), or `--staged` against the index. Optional `paths` filter scopes the diff. Read-only; worktree mode only.',
	request_plan_approval:
		'Ask the user to approve a plan file and hand the conversation to an implementer agent. Write the plan into the workspace first (Write, e.g. PLAN.md), then pass its path. Mandatory approval: the user must approve in the inline card before this runs. On approve the bound agent flips to implementerAgentId and the next round runs under that agent, which can read the file with Read. On deny the planner stays bound. implementerAgentId is the full agent id — call list_agents to get it; the built-in Chat and Autonomous agents are the usual implementers.',
}

/**
 * Realistic example invocations per tool, attached to tool definitions as `input_examples`.
 * Anthropic models are documented to use these to infer conventions (kebab-case, ID prefix
 * shapes, when to populate optional blocks) — their internal eval reported a 72%→90% accuracy
 * lift on complex parameter handling.
 *
 * OpenRouter passes through extra fields on tool definitions; if a provider doesn't recognize
 * `input_examples` it simply ignores the field. Empty/undefined entries get omitted from the
 * tool def by `getToolDefinitions`.
 *
 * Keep examples short — every byte ships in the tool defs prefix on every request. Five
 * high-cardinality tools have examples; the long tail relies on description + schema alone.
 */
export const toolExamples: Partial<Record<ToolName, unknown[]>> = {
	web_search: [
		{ query: 'sveltekit remote functions 2026' },
		{ query: 'pgvector hnsw vs ivfflat benchmark' },
	],
	create_monitor: [
		// Deterministic path — narrow `extract` so the comparison is on the thing that matters.
		{
			name: 'Release notes page changes',
			condition: {
				kind: 'tool_result',
				tool: 'web_fetch',
				args: { url: 'https://example.com/releases' },
				extract: 'text',
				compare: 'changed',
			},
			action: 'push',
			intervalSeconds: 3600,
			deadlineDays: 14,
		},
		// Fuzzy path — a yes/no question over fetched context, billed on every check.
		{
			name: 'PR 412 checks go green',
			condition: {
				kind: 'model_question',
				question: 'Have all CI checks on pull request 412 finished successfully?',
				context: [{ tool: 'list_pull_requests', args: { owner: 'acme', repo: 'widgets' } }],
			},
			action: 'start_conversation',
			actionConfig: { prompt: 'CI is green on PR 412. Review the diff and summarize what changed.' },
			intervalSeconds: 600,
			deadlineDays: 3,
			maxChecks: 100,
		},
	],
	request_plan_approval: [
		{
			path: 'plan.md',
			implementerAgentId: '00000000-0000-0000-0000-000000000000',
			rationale: 'Hand off to the coding agent to implement the approved plan.',
		},
	],
}
