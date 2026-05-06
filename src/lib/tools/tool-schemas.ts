import { z } from 'zod'

/**
 * Declarative tool surface — Zod input schemas + human-readable descriptions for every
 * tool the assistant can invoke. Kept here (rather than alongside `executeTool`) because
 * other modules (the runtime loop, settings UI, capability classifier) need the schema
 * shape without dragging in the entire 2000-line executor.
 */

export const toolSchemas = {
	web_search: z.object({ query: z.string().min(1) }),
	shell: z.object({ command: z.string().min(1) }),
	file_read: z.object({
		path: z.string().min(1),
		startLine: z.number().int().min(1).optional(),
		endLine: z.number().int().min(1).optional(),
	}),
	file_write: z.object({ path: z.string().min(1), content: z.string() }),
	file_patch: z.object({ patch: z.string().min(1) }),
	file_replace: z.object({
		path: z.string().min(1),
		oldStr: z.string().min(1),
		newStr: z.string(),
		requireUnique: z.boolean().default(true),
		replaceAll: z.boolean().default(false),
	}),
	list_directory: z.object({
		path: z.string().min(1).optional(),
		depth: z.number().int().min(0).max(6).default(1),
		includeHidden: z.boolean().default(false),
	}),
	delete_file: z.object({ path: z.string().min(1), recursive: z.boolean().default(false) }),
	move_file: z.object({
		fromPath: z.string().min(1),
		toPath: z.string().min(1),
		overwrite: z.boolean().default(false),
	}),
	search_files: z.object({
		query: z.string().min(1),
		path: z.string().min(1).optional(),
		maxResults: z.number().int().min(1).max(200).default(50),
		isRegex: z.boolean().default(false),
		includeIgnored: z.boolean().default(false),
		caseSensitive: z.boolean().default(false),
	}),
	file_info: z.object({ path: z.string().min(1) }),
	browser_screenshot: z.object({ url: z.string().url().optional() }),
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
	// Wave 4 #15 phase 2 — Projects + Artifacts agent tools.
	list_projects: z.object({}),
	create_project: z.object({
		name: z.string().trim().min(1).max(120),
		kind: z.enum(['efoil', 'research', 'code', 'documentation', 'other']).optional(),
		description: z.string().trim().max(1000).optional(),
	}),
	list_artifacts: z.object({
		projectId: z.string().uuid(),
		includeInactive: z.boolean().default(false).optional(),
	}),
	read_artifact: z.object({
		artifactId: z.string().uuid(),
	}),
	create_artifact: z.object({
		projectId: z.string().uuid(),
		name: z.string().trim().min(1).max(160),
		content: z.string(),
		contentType: z.enum(['markdown', 'code', 'json', 'yaml', 'plaintext']).optional(),
		changeNote: z.string().trim().max(500).optional(),
	}),
	edit_artifact: z.object({
		artifactId: z.string().uuid(),
		content: z.string(),
		changeNote: z.string().trim().max(500).optional(),
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
	ask_user: z.object({
		questions: z
			.array(
				z.object({
					header: z.string().min(1),
					question: z.string().min(1),
					options: z
						.array(
							z.object({
								label: z.string().min(1),
								description: z.string().optional(),
								recommended: z.boolean().optional(),
							}),
						)
						.default([]),
					allowFreeformInput: z.boolean().default(true),
				}),
			)
			.min(1)
			.max(8),
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
	enable_capability: z.object({
		group: z.enum(['core', 'sandbox', 'skills', 'agents', 'media']),
	}),
	propose_plan: z.object({
		summary: z.string().min(1).max(500),
		steps: z
			.array(
				z.object({
					title: z.string().min(1).max(200),
					detail: z.string().max(1000).optional(),
					estimatedDurationMin: z.number().int().positive().max(10_000).optional(),
					estimatedCostUsd: z.number().nonnegative().max(1000).optional(),
					blastRadius: z.enum(['local', 'shared', 'production']).optional(),
					reversible: z.boolean().optional(),
				}),
			)
			.min(1)
			.max(20),
		risks: z.array(z.string().min(1).max(280)).max(10).optional(),
		rollback: z.string().max(1000).optional(),
		totalEstimatedCostUsd: z.number().nonnegative().max(1000).optional(),
		totalEstimatedDurationMin: z.number().int().positive().max(10_000).optional(),
	}),
}

export type ToolName = keyof typeof toolSchemas

export const allToolNames = Object.keys(toolSchemas) as ToolName[]

export const toolDescriptions: Record<ToolName, string> = {
	web_search: 'Search the web for information.',
	shell: 'Run a shell command in the sandboxed environment.',
	file_read: 'Read a file from the sandbox filesystem, optionally by line range.',
	file_write: 'Write content to a file in the sandbox filesystem.',
	file_patch: 'Apply a unified diff patch to files in the sandbox workspace.',
	file_replace:
		'Replace an exact string in a file. By default requires exactly one match, making edits deterministic and retry-safe.',
	list_directory: 'List files and directories with depth and hidden-file controls.',
	delete_file: 'Delete a file or directory (recursive deletes require explicit recursive=true).',
	move_file: 'Move or rename a file/directory within the sandbox workspace.',
	search_files: 'Search file contents in the workspace (ripgrep-style) with optional regex and ignore controls.',
	file_info: 'Get file or directory metadata (size, modified time, permissions).',
	browser_screenshot: 'Take a screenshot of a web page.',
	web_fetch: 'Fetch the full text content of a web page (HTTP/HTTPS only). Returns { title, url, text, fetchedAt } with the body text trimmed to maxChars (default 50,000). Blocks private/loopback addresses to prevent SSRF. Use this when web_search snippets are insufficient and you need to read the actual page content.',
	pdf_read: 'Extract text from a PDF — accepts an HTTP/HTTPS URL OR an absolute path to a PDF the agent has already written into its sandbox workspace. Uses pdftotext (poppler-utils) under the hood; returns { source, text, charCount, truncated, pageHint }. Same SSRF protection as web_fetch for URLs. Use this for whitepapers, datasheets, regulatory filings, or research-attached PDFs that web_fetch can\'t parse.',
	list_projects: 'List the user\'s projects (durable containers for artifacts with append-only version history). Returns id, name, slug, kind, description for each project.',
	create_project: 'Create a new project to group related artifacts. Slug auto-generated from name + deduped per-user. Kinds: efoil/research/code/documentation/other.',
	list_my_repos: 'List source-control repositories the user has connected to AgentStudio (after OAuth). Optional `search` substring on owner/name. Returns id, owner, name, defaultBranch, htmlUrl, private. Run `sync_my_repos` first if the list looks empty or stale.',
	sync_my_repos: 'Sync the user\'s GitHub repos into AgentStudio (idempotent). Requires the user to have connected GitHub at /source-control. Returns {total, inserted, updated, skipped} or an errorMessage when the connection is missing/expired.',
	prepare_commit: 'Inspect a working tree (defaults to the workspace root; supply a relative `path` to inspect a subdirectory) and produce a structured commit draft. Returns {branch, upstream, ahead, behind, dirty, diff: {filesChanged, insertions, deletions, files}, suggestedSubject, files}. Read-only — no commit/push happens. Use as the first step before requesting human approval to push or open a PR. The path must be a git repository (has a .git entry); otherwise the call fails with a clear error.',
	push_branch: 'Push a local branch to GitHub. ALWAYS REQUIRES OPERATOR APPROVAL — mandatory regardless of per-tool settings, refused entirely in detached/automation runs. Authenticates with the user\'s connected GitHub OAuth token (no SSH keys). Pushes to `https://github.com/<owner>/<repo>.git` so the local `origin` remote is irrelevant; `branch` defaults to the current HEAD if omitted. `force=true` enables `--force-with-lease` (safer than plain --force; rejected if the remote ref moved since last fetch). Returns {success, branch, remote, stdout, stderr, exitCode} with the token redacted from any output.',
	create_pull_request: 'Open a pull request on GitHub against an attached repository. ALWAYS REQUIRES OPERATOR APPROVAL — mandatory regardless of per-tool settings, refused entirely in detached/automation runs. `head` is the source branch (or `owner:branch` for cross-fork PRs); `base` is the target branch (typically the repo default). `draft=true` opens a draft PR (the default). Persists the resulting PR row to the source-control schema linked to the active run, and opens a `pull_request_ready` review-inbox item so an operator can spot the new PR in /review. Returns {number, htmlUrl, state, draft, recordedId}.',
	list_pull_requests: 'List pull requests recorded for a repository (the user must have synced the repo via sync_my_repos first). Returns up to `limit` rows (default 50) ordered by most recently updated, each with {id, providerPrNumber, title, status, headBranch, baseBranch, providerUrl, runId, taskId, createdBy, createdAt, updatedAt}. Read-only. Returns an empty list when the repo has no recorded PRs yet.',
	get_pull_request: 'Fetch a single pull request by its AgentStudio id (the `recordedId` returned by create_pull_request, or any id from list_pull_requests). Returns the full row including title, body, status, head/base branches, providerUrl, runId, taskId, metadata. Read-only. Returns null when the id is unknown.',
	clone_repository: 'Materialize a local clone of a connected GitHub repo under the per-user sandbox (`${SANDBOX_WORKSPACE}/<userId>/repos/<owner>/<repo>`). Idempotent — if the path already has a clone, runs `git fetch --prune` instead of re-cloning. Authenticated via the user\'s stored OAuth token (private repos work without the agent ever seeing the token). Returns {path, fresh, branch} where `fresh=true` indicates a brand-new clone vs. an updated existing one. Refuses repos the user has not connected (i.e., not present in the sync\'d list). After clone, use prepare_commit / push_branch / create_pull_request against the returned path.',
	list_artifacts: 'List artifacts in a project. Returns id, name, slug, contentType, isActive for each artifact (active by default; pass includeInactive to see soft-deleted).',
	read_artifact: 'Read an artifact\'s current version content. Returns name, contentType, version seq, content, and the artifact\'s project info. Use to load an artifact before editing.',
	create_artifact: 'Create a new artifact in a project (saves the initial content as v1). Slug auto-generated from name. Optional changeNote describes what this initial version contains.',
	edit_artifact: 'Append a new version to an existing artifact (append-only, preserves the full history). Optional changeNote describes what changed in this version. Use read_artifact first to see the current content.',
	set_project_context: 'Bind a project to the current conversation so subsequent agent edits know which project to target by default. Pass projectId=null (or omit) to unbind. The bound project shows up in the conversation\'s system-prompt context slot so the agent has continuous awareness of which project is "in scope".',
	run_subagent:
		'Run a subagent to handle a task. Optionally specify agentId to delegate to a specific agent. Without agentId, uses a general-purpose stateless subagent.',
	image_generate: 'Generate an image from a text prompt.',
	update_agent: 'Update an existing agent fields such as name, role, model, or system prompt.',
	pause_agent: 'Pause an agent so it is not used for delegations.',
	resume_agent: 'Resume a paused agent and mark it active again.',
	create_automation: 'Create a recurring automation that triggers an agent prompt on a cron schedule.',
	list_automations: 'List automations for the current user.',
	update_automation: 'Update an existing automation schedule, prompt, mode, or enabled state.',
	delete_automation: 'Delete an automation by id.',
	ask_user:
		'Ask the user one or more focused clarifying questions with prefilled answer options. Each question should have ~3 prefilled options — prefer splitting a broad inquiry into multiple focused questions rather than providing many options in a single question. Use when you need explicit user input before proceeding.',
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
	propose_plan:
		'Propose a structured execution plan to the user with ordered steps, estimated cost/time, risks, and rollback. The user explicitly approves or denies before you call any non-readonly tool. Required in plan mode; should be called before taking any destructive or expensive action.',
	enable_capability:
		'Enable a capability group (sandbox / skills / agents / media) so its tools become available on the next round. Use this when the task clearly needs filesystem operations, skill management, agent delegation, or image generation. The active surface starts with only the `core` group; expand on demand to keep the prompt slim.',
}
