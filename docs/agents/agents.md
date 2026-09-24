# Agents

This page describes agents in plain English. For the full data model and design notes, see [spec.md](spec.md). For the build history, see [plan.md](plan.md).

## Overview

An agent is a named AI persona: a name, a role, a system prompt (its instructions), a model, and a set of tools it may use. Every conversation is bound to one agent. The person who runs this AgentStudio instance sees all agents at `/agents` and can open any one at `/agents/[id]`.

There are three kinds of agent:

| Kind | What it is | Examples |
| ---- | ---------- | -------- |
| Built-in | Shipped with the app. Created again at every startup if missing. | Chat, Research, Plan, Autonomous |
| Custom | Created by the user, usually by asking the assistant to make one. | "Reviewer", "Release notes writer" |
| Evaluator | Grades other agents' runs after they finish. The runtime starts it, not the user. | Default Evaluator |

## Key concepts

### Delegation

A built-in agent can hand part of a task to a custom agent. The built-in agent is told which agents it can hand work to, and it asks for one by name. At most 12 custom agents are offered at once, newest first. Built-in agents and evaluators are never offered.

### Status: Available or Paused

Every agent is either **Available** or **Paused**.

| Status | Offered for delegation | Run by its automations and monitors | Can be chatted with directly |
| ------ | ---------------------- | ----------------------------------- | ---------------------------- |
| Available | Yes (custom agents only) | Yes | Yes |
| Paused | No | No — each run is skipped and recorded | Yes |

Pausing is a way to bench an agent without deleting it. It is useful because only 12 agents are offered for delegation, and each one offered adds to the cost of every request.

The database stores three values: `active`, `idle` and `paused`. `active` and `idle` mean the same thing and both show as Available. New agents start as `idle`; resuming an agent writes `active`.

### Built-in agents keep your edits

The four built-in agents are checked at every startup, and every deploy is a startup. A missing built-in is created again. An existing one has only the parts the app owns refreshed:

| Refreshed at every startup | Left as you set it |
| -------------------------- | ------------------ |
| Name and role description | The system prompt (after it is first written) |
| The reminder shown when a conversation switches to the agent | Hook bindings |
| The list of tools Research and Plan may use | Research settings |
| | A linked identity skill |

A linked identity skill is only unlinked at startup if the skill has since been deleted, or if it is one of the old `system/` skills the built-ins used to point at.

Before this, every startup replaced the whole agent configuration and unlinked any identity skill, so each deploy quietly undid hook bindings and identity edits on the built-in agents.

### Identity skills

An agent's instructions can live in its system prompt or in a linked **identity skill**, which is edited at `/agents/[id]/identity`.

- **Promote to skill** copies the system prompt into a new skill named `agent/<name>-<first 8 characters of the id>/identity` and links it. Edits there take effect on the agent's next run.
- **Unlink skill** makes the agent use its system prompt again. The skill itself stays in `/skills`.
- **Promote to skill** after an unlink links that same skill again, with the content as you last left it. (It used to try to create a second skill with the same name and fail every time.)

## User flows

### Pause an agent

1. Open `/agents`, or open the agent's own page at `/agents/[id]`.
2. Press **Pause** on the agent's card, or in the page header on its own page.
3. The status changes to **Paused**. The agent's page explains what that means.
4. The change is recorded in the audit trail (`/audit`) as "Agent status changed", with who made it.

From then on:

- A built-in agent that delegates work no longer sees this agent.
- Each automation assigned to it is skipped when it comes due. The run history on `/automations` shows the skipped run as **blocked**, with the reason "agent … is paused". The schedule moves on to the next time as usual. "Run now" is skipped the same way.
- A monitor that would start a conversation with it does not. The monitor opens a review item instead, so what it saw is not lost.
- You can still open a chat with it and talk to it directly.

The automation cards on `/automations` show "(paused)" next to the agent's name, and the agent picker on the new-automation form marks it the same way.

### Resume an agent

1. Press **Resume** on the agent's card or page.
2. The status changes back to **Available** and the change is recorded in the audit trail.
3. Its automations run again from their next scheduled time. Skipped runs are not made up.

The assistant can also pause and resume agents itself with its `pause_agent` and `resume_agent` tools. The same rules apply, and the audit trail shows no person for those changes.

### Create an agent

1. Open `/agents/new`, or ask the assistant in any chat to make one.
2. A guided **Create agent** chat opens. The assistant asks what the new agent should do, then creates it.
3. `/agents/new` swaps itself for the chat in the browser history, so **Back** from the chat returns to wherever you came from. It used to start another chat instead, and each start is a new conversation and a paid model run.

### Watch an agent work

While an agent is running, its card on `/agents` and its own page show the latest text it has written, with a **Watch live** link to the conversation. A run that has started but not written anything yet shows an empty preview. (Both pages used to crash the moment an agent started running.)

### Hand a plan over from Plan or Research

1. The user asks the Plan agent to plan a change, or the Research agent to research a question.
2. The agent writes its plan to a markdown file (`PLAN.md` or `RESEARCH-PLAN.md`) and posts it in its reply.
3. It calls `request_plan_approval` with the file and the **full id** of the agent that should carry the plan out. An approval card appears in the chat.
4. On **Approve**, the conversation switches to that agent, which reads the plan file and does the work. On **Deny**, the planning agent stays, and the user usually says what to change.

The agent that carries out the plan is usually Chat or Autonomous. Both agents are always told those two agents' ids, because the ids never change. For any other agent, they call `list_agents`, a read-only tool that lists every agent with its full id, name, role, whether it is built-in, and whether it is paused.

There is no separate "research runner" agent. An approved research plan goes to Chat, which has web search, page fetching and PDF reading, unless the user asks for another agent.

Before this, the handoff could not complete: `request_plan_approval` needs a full id, the agents' instructions pointed at a `list_agents` tool that did not exist, and the only list of agents the model ever saw showed shortened ids.

## Roles & permissions

AgentStudio has a single owner and no admin tier. The owner can view every agent, pause and resume custom agents, and edit an agent's model, system prompt and hooks. The model picker offers only models a chat can run on here — Claude, plus gateway models when a gateway is configured — and a change to any other model is refused, because an agent's model is what the conversations it starts run on. An agent already on such a model keeps it until it is changed. The chat agent's `update_agent` tool follows the same rule: asked to move an agent to a model that cannot run, it says why and changes nothing. See [../llm/llm.md](../llm/llm.md).

Some agents cannot be paused:

- **Built-in agents** are never offered for delegation, because they are the ones doing the delegating. For them, "paused" would only mean "its automations stop", which is a different promise from the one the button makes. The Chat agent is also the default for new conversations. To stop an automation that uses a built-in agent, disable the automation.
- **Evaluators** grade runs whatever their status, and are never offered for delegation. A Pause button would promise something it does not do.

These agents show a **Built-in** or **Evaluator** label and have no Pause button. The server refuses the request as well, so the rule holds even for a request made outside the page. A built-in agent that was paused before this rule existed can still be resumed.

## Built-in agents and their tools

| Agent | Tools |
| ----- | ----- |
| Chat | All tools |
| Autonomous | All tools |
| Research | Read-only tools (including `list_agents`), plus `Write` and `request_plan_approval` |
| Plan | Read-only tools (including `list_agents`), plus `Write` and `request_plan_approval` |
| Custom agent | All tools, unless its settings list the only tools it may use |

Research and Plan share one list of allowed tools. That list includes `Write`, and this is deliberate (decided in issue #67). Both agents work the same way: they write their plan to a markdown file (`RESEARCH-PLAN.md` or `PLAN.md`), then ask the user to approve it with `request_plan_approval`. That tool reads the plan from the file, so Research needs `Write` as much as Plan does. Taking it away would break Research's only workflow.

Research and Plan cannot run shell commands, edit files in place, push code or open pull requests. Every tool call they make is still checked against the workspace and the approval settings.

## Integrations

- **Claude Agent SDK.** The custom agents a run may delegate to are passed to the SDK as its list of agents. The SDK describes each one in its delegation tool, `Agent`. The built-in agents' instructions point there instead of keeping a list of their own, so the two cannot disagree.
- **Automations and monitors.** Both check the agent's status before running it. See [../automations/spec.md](../automations/spec.md) and [../monitors/spec.md](../monitors/spec.md).
- **Hooks.** The hook bindings saved on an agent's page run for its chats as well as its automations. See [../hooks/hooks.md](../hooks/hooks.md).
- **Audit trail.** Every change of status is recorded as `agent.status.changed`.

## Business rules

- Paused is the only status that changes behaviour. `active` and `idle` are both Available.
- Only custom agents can be paused. Any paused agent can be resumed.
- Resuming an agent that is not paused changes nothing and records nothing.
- A paused agent is not offered for delegation, and automations and monitors do not run it. Direct chats are not affected.
- An automation skipped because its agent is paused is not a failure. It does not count toward the five failures that switch an automation off, and it does not reset that count.
- A skipped scheduled run moves the schedule on. A skipped "Run now" or monitor-started run leaves it where it was.
- An automation with no agent is never affected by any agent's status.
- A startup never overwrites a built-in agent's hook bindings, research settings, system prompt or identity skill. Only its name, role, switch reminder and tool list follow the code.
- `request_plan_approval` only accepts a full agent id. `list_agents` is how the model finds one.
- Promoting an agent to an identity skill re-uses the agent's existing identity skill when there is one.
