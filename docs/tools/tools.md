# Tools

## Overview

Tools are the actions an agent can take during a conversation: search the web, read a PDF, open a pull request, schedule an automation, and so on. When the agent decides it needs one, it asks for it by name, AgentStudio runs it, and the result goes back to the agent.

An agent in a chat has two kinds of tools:

- **Claude's own tools**, which come with the Claude Agent SDK: reading, writing and editing files (`Read`, `Write`, `Edit`), finding files (`Glob`, `Grep`), running commands (`Bash`), and handing work to another agent (`Agent`).
- **AgentStudio's tools**, about 45 of them, which do things only this app can do: its web search, projects, source control, agents, automations, monitors, skills, and image and video generation.

This page is about AgentStudio's tools. [`spec.md`](spec.md) describes an earlier design (capability groups and `enable_capability`) that is no longer how the app works, apart from its sections on web access safety and web tool limits, which are current.

## Key concepts

| Term | What it means |
| --- | --- |
| **Tool registry** | The single list of AgentStudio's tools: each tool's name, what it accepts, and the description the agent reads. Everything else is derived from it. |
| **Engine** | The Claude Agent SDK loop that runs every chat. It offers the agent the whole registry, except `run_subagent` (delegation is Claude's `Agent` tool now). |
| **Approval** | A pause before a tool runs, until you press Allow or Deny on the card in the chat. |
| **Mandatory approval** | `push_branch`, `create_pull_request` and `request_plan_approval` always ask, whatever your settings say. |
| **Workspace** | The folder a run works in. File tools and commands stay inside it. |
| **Old loop** | The chat loop AgentStudio used before the Agent SDK. It still runs a few unattended jobs (see below). |

The groups of AgentStudio tools:

| Group | Tools |
| --- | --- |
| Web and documents | `web_search`, `web_fetch`, `pdf_read`, `browser_screenshot` |
| Files (beyond Claude's own) | `file_info`, `move_file`, `delete_file` |
| Projects | `list_projects`, `create_project`, `set_project_context` |
| Source control | `list_my_repos`, `sync_my_repos`, `clone_repository`, `git_status`, `git_log`, `git_diff`, `prepare_commit`, `push_branch`, `create_pull_request`, `list_pull_requests`, `get_pull_request` |
| Agents and planning | `list_agents`, `update_agent`, `pause_agent`, `resume_agent`, `request_plan_approval`, `run_subagent` |
| Automations and monitors | `create_automation`, `list_automations`, `update_automation`, `delete_automation`, `create_monitor`, `list_monitors`, `cancel_monitor`, `extend_monitor` |
| Skills | `list_skills`, `read_skill`, `read_skill_file`, `create_skill`, `update_skill`, `add_skill_file`, `update_skill_file`, `delete_skill`, `delete_skill_file` |
| Media | `image_generate`, `video_generate` |
| Conversation | `ask_user` |

## User flows

### An agent uses a tool in a chat

1. The agent asks for a tool by name, with its inputs.
2. AgentStudio checks whether the call may go ahead: the agent's own tool list, the conversation's permission mode, your approval settings, and whether the call stays inside the workspace.
3. If the call needs approval, a card appears in the chat and the run waits for your answer.
4. The tool runs and its result goes back to the agent. The chat shows it as a tool card.

### Choosing which tools ask first

1. Open **Settings → Tool Approval**.
2. Tick a tool to make it ask before it runs, or untick it. Every tool in the list can be ticked, including `web_search`. **All** and **None** tick or untick the whole list.
   The three mandatory-approval tools are the exception: they show ticked, marked "always asks", and cannot be unticked, and **All** and **None** leave them alone, because they ask whatever you choose.
3. Or turn on **Require approval for all tools**, which covers every tool, Claude's own included, and overrides the ticks.
4. Press **Save**.

The list shows exactly the AgentStudio tools a chat can call and an approval can pause. `ask_user` is not on it: it is the agent asking you a question, answered in its own card, so there is nothing to approve. The list used to be split into an "Always loaded" group, whose ticks could not be changed, and a "Searchable" group. Both described a way of loading tools that the chat engine never had, so the split is gone.

### Running code

There is no separate code tool. The agent writes a script into the workspace and runs it with Claude's `Bash` tool, the same way it runs any command.

- In production, `Bash` runs inside an operating-system sandbox (bubblewrap) that keeps it to the workspace, so it runs without asking.
- Where the sandbox is not available, such as a developer's Windows or Mac machine, every `Bash` call asks for approval first.

A script cannot call AgentStudio's tools. The agent calls those itself, several in one step if they do not depend on each other.

## Roles and permissions

AgentStudio has one user, the owner, who can change every setting on this page.

What an agent may call depends on the agent:

| Agent | Tools |
| --- | --- |
| Chat and Autonomous (built-in) | All of them |
| Research and Plan (built-in) | A read-only list, plus `Write` so the plan can be saved and `request_plan_approval` to hand it over |
| A custom agent with an `allowedTools` list | Exactly that list |
| A custom agent without one | All of them |

The conversation's permission mode (Plan only, Ask, Accept edits, Bypass) applies on top of this. The mandatory-approval tools ask in every mode.

## Integrations

- **Claude Agent SDK.** AgentStudio's tools are handed to it as an in-process tool server, so the agent sees them next to Claude's own.
- **MCP endpoint (`/api/mcp`).** Other programs can call AgentStudio's tools over the Model Context Protocol. It offers every AgentStudio tool except the ones that only work inside a chat: `ask_user` (there is no chat to ask in), the three mandatory-approval tools (there is nobody to press Allow) and `set_project_context` (there is no conversation to bind). They are not listed, and a request to run one is refused before anything happens.
- **OpenRouter.** The old loop sends its tools to models through OpenRouter.
- **GitHub.** The source-control tools use your connected GitHub account.
- **SearXNG.** `web_search` goes to the self-hosted search engine.

## Business rules

- A tool the engine does not offer cannot be called in a chat, whatever the settings say.
- `push_branch`, `create_pull_request` and `request_plan_approval` always need approval, and refuse to run where nobody can approve them, such as an automation.
- File tools and commands stay inside the run's workspace.
- The web tools (`web_fetch`, `pdf_read`, `browser_screenshot`) reach the public internet and nothing else: an address on this machine, a private network or a cloud metadata service is refused, including when a page redirects to one. Each browser call opens its own session and closes it afterwards, so `browser_screenshot` always needs a URL. See [spec.md](spec.md#web-access-safety-the-egress-guard).

### Unattended runs on the old loop

Three kinds of job still run on the old loop, with no person watching:

- an automation that has an agent attached;
- a monitor whose action is to start a conversation;
- a CI fix run started from the review inbox.

These runs are offered one AgentStudio tool: `web_search`. An agent's `allowedTools` list can take it away but cannot add others. None of Claude's own tools are available there, so these runs cannot read or change files, run commands, or push anything. If the agent asks for any other tool anyway (for example because a web page it read told it to), the run refuses the call before anything happens and tells the agent that tool is not available to this run.

Until September 2026 they could also use two tools that have since been removed:

- **`run_code`** ran a JavaScript program that could call other tools from inside the script. It never worked in chat, and it was removed rather than rebuilt (#69), because `Bash` already runs scripts and one step can call several tools at once.
- **`search_tools`** let the agent look up tools that were not in its list. The chat engine never needed it, because it offers every tool from the start, and it was removed with the rest of that loading scheme (#8).

Moving these jobs onto the chat engine will give them the same tools as a chat.
